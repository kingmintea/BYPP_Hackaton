"""
공지사항 감지 웹앱을 위한 개발 서버.

- 정적 파일(index.html, style.css, watcher.js, board/*)을 서빙한다.
- 등록된 사이트 목록/목업 게시판 글/자동 확인 시각 설정을 서버가 JSON 파일로 관리한다
  (브라우저 localStorage가 아님 — 브라우저가 꺼져 있어도 서버는 계속 돌아가야 하기 때문).
- 백그라운드 스레드가 매 5초마다 "지금이 설정된 자동 확인 시각(HH:MM)인가"를 확인하고,
  맞으면 등록된 모든 사이트를 서버가 직접 크롤링해서 결과를 저장한다.
  → 브라우저를 열어두지 않아도 서버만 켜져 있으면 자동 확인이 동작한다.
- /board/index.html 은 board_notices.json을 읽어 서버가 직접 HTML로 렌더링한다
  (클라이언트 JS가 아니라 서버가 렌더링해야, 서버 크롤러가 원본 HTML만 읽어도 글 목록이 보인다).
"""

import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, "data")
SITES_FILE = os.path.join(DATA_DIR, "sites.json")
NOTICES_FILE = os.path.join(DATA_DIR, "board_notices.json")
SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")
PORT = 8420
BASE_URL = f"http://localhost:{PORT}"

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
}

SEED_NOTICES = [
    {"id": 3, "title": "2026-2학기 수강정정 안내", "author": "정보대학행정팀", "date": "2026.09.10"},
    {"id": 2, "title": "학생예비군 훈련 관련 안내", "author": "정보대학행정팀", "date": "2026.09.05"},
    {"id": 1, "title": "2027년 2월 졸업예정자 졸업 요구 조건 제출 안내", "author": "정보대학행정팀", "date": "2026.09.01"},
]

DEFAULT_SETTINGS = {"dailyCheckTime": "09:00"}

data_lock = threading.Lock()


# ---------- 저장소 ----------

def _load_json(path, default):
    if not os.path.exists(path):
        _save_json(path, default)
        return json.loads(json.dumps(default))
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _save_json(path, obj):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


def load_sites():
    with data_lock:
        return _load_json(SITES_FILE, [])


def save_sites(sites):
    with data_lock:
        _save_json(SITES_FILE, sites)


def load_notices():
    with data_lock:
        return _load_json(NOTICES_FILE, SEED_NOTICES)


def save_notices(notices):
    with data_lock:
        _save_json(NOTICES_FILE, notices)


def load_settings():
    with data_lock:
        return _load_json(SETTINGS_FILE, DEFAULT_SETTINGS)


def save_settings(settings):
    with data_lock:
        _save_json(SETTINGS_FILE, settings)


# ---------- 크롤링 ----------

class ArticleTitleParser(HTMLParser):
    """
    게시판 목록에서 글 제목을 뽑아낸다. 실제 대학 사이트 세 곳을 비교해보니 태그 종류(a/td/dt)와
    class 이름이 제각각이었지만, 공통적으로 제목을 감싸는 어딘가에 "title"이라는 단어가 class에
    포함돼 있었다. 그래서 특정 태그/정확한 class명을 하드코딩하는 대신, "class 속성에 'title'이라는
    글자가 들어간 태그(자기 자신이든 조상이든) 안에 있는 <a> 태그의 글자"를 제목으로 인식한다.
      - <a class="article-title">제목</a>                                 (정보대학, 목업 게시판)
      - <td class="title">...<a>제목</a>...</td>                          (안암학사 dorm.korea.ac.kr)
      - <dt class="board-list-content-title ...">...<a>제목</a>...</dt>   (성균관대 skku.edu)
    이 규칙과도 안 맞는 사이트가 있으면(예: class에 title이란 단어가 전혀 없는 경우), 그 사이트의
    HTML을 확인해서 이 클래스에 새로운 인식 규칙을 추가해야 한다.
    """

    # 닫는 태그가 없는(자식을 가질 수 없는) 태그들. 이런 태그의 class에 "title"이 들어 있어도
    # 조상 스택에 올리면 안 된다 — handle_endtag가 절대 호출되지 않아 스택이 영영 안 빠지기 때문.
    VOID_TAGS = {
        "area", "base", "br", "col", "embed", "hr", "img",
        "input", "link", "meta", "source", "track", "wbr",
    }

    def __init__(self):
        super().__init__()
        self.titles = []
        self._capture = False
        self._buffer = ""
        self._title_ancestor_stack = []  # class에 "title"이 들어간, 지금 열려 있는 태그들

    def handle_starttag(self, tag, attrs):
        attrs_dict = dict(attrs)
        classes = (attrs_dict.get("class") or "").split()
        has_title_class = any("title" in c.lower() for c in classes)

        if has_title_class and tag not in self.VOID_TAGS:
            self._title_ancestor_stack.append(tag)

        if tag == "a" and not self._capture:
            if has_title_class or self._title_ancestor_stack:
                self._capture = True
                self._buffer = ""

    def handle_data(self, data):
        if self._capture:
            self._buffer += data

    def handle_endtag(self, tag):
        if tag == "a" and self._capture:
            self._capture = False
            title = " ".join(self._buffer.split()).strip()
            if title:
                self.titles.append(title)
        if self._title_ancestor_stack and self._title_ancestor_stack[-1] == tag:
            self._title_ancestor_stack.pop()


class CrawlError(Exception):
    """URL 등록/확인 시 사용자에게 그대로 보여줄 수 있는, 케이스별로 구분된 오류 메시지."""


def resolve_url(url):
    if url.startswith("http://") or url.startswith("https://"):
        return url
    return f"{BASE_URL}/{url.lstrip('/')}"


def crawl(url):
    req = urllib.request.Request(
        url, headers={"User-Agent": "Mozilla/5.0 (NoticeWatcherDemoBot)"}
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        charset = resp.headers.get_content_charset() or "utf-8"
        html = resp.read().decode(charset, errors="replace")
    parser = ArticleTitleParser()
    parser.feed(html)
    return parser.titles


def validate_and_crawl(url):
    """URL을 검증하고 크롤링한다. 실패 케이스마다 다른 메시지의 CrawlError를 던진다."""
    # http(s)://로 시작하지 않는 입력은 "이 서버 안의 상대 경로"(예: board/index.html)로 간주해서
    # 자동으로 완전한 주소를 만들어준다. 이 경우 'asdfasdgsdg' 같은 오타/무의미한 입력도 문법적으로는
    # 멀쩡한 URL이 되어버리므로, 실패 시 relative 여부에 따라 메시지를 다르게 준다.
    is_relative_guess = not (url.startswith("http://") or url.startswith("https://"))
    resolved = resolve_url(url)
    parsed = urllib.parse.urlparse(resolved)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise CrawlError("올바른 URL 형식이 아닙니다.")

    try:
        titles = crawl(resolved)
    except urllib.error.HTTPError as e:
        if is_relative_guess:
            raise CrawlError(
                f"'{url}' 경로를 찾을 수 없습니다 (HTTP {e.code}). "
                "외부 사이트는 https://(또는 http://)로 시작하는 전체 주소를, "
                "이 서버 안의 페이지는 board/index.html처럼 실제 경로를 입력해주세요."
            )
        raise CrawlError(f"사이트가 오류를 반환했습니다 (HTTP {e.code}).")
    except urllib.error.URLError as e:
        raise CrawlError(f"사이트에 접속할 수 없습니다: {e.reason}")
    except (ValueError, ConnectionError, TimeoutError, OSError) as e:
        raise CrawlError(f"사이트에 접속할 수 없습니다: {e}")

    if not titles:
        raise CrawlError(
            "공지 목록을 찾을 수 없습니다. 이 페이지의 게시판 구조를 지원하지 않을 수 있어요."
        )
    return titles


def korean_time_str(dt):
    period = "오전" if dt.hour < 12 else "오후"
    hour12 = dt.hour % 12 or 12
    return f"{period} {hour12}:{dt.minute:02d}:{dt.second:02d}"


def perform_check(site):
    try:
        titles = validate_and_crawl(site["url"])
        if site.get("lastTitles") is None:
            site["lastTitles"] = titles
            site["status"] = f"기준 상태 저장됨 ({len(titles)}건) — {korean_time_str(datetime.now())}"
        else:
            new_titles = [t for t in titles if t not in site["lastTitles"]]
            keywords = site.get("keywords") or []
            if keywords:
                matched = [t for t in new_titles if any(k in t for k in keywords)]
            else:
                matched = new_titles
            site["lastTitles"] = titles
            if matched:
                site["triggered"] = True
                site["status"] = f"새 글 감지: {' / '.join(matched)} — {korean_time_str(datetime.now())}"
            else:
                site["status"] = f"변경 없음 — {korean_time_str(datetime.now())}"
    except Exception as e:
        site["status"] = f"확인 실패: {e}"
    site["lastCheckedAt"] = datetime.now().isoformat()
    return site


def check_all_sites():
    sites = load_sites()
    for site in sites:
        perform_check(site)
    save_sites(sites)
    return sites


# ---------- 자동 확인 스케줄러 (서버가 켜져 있는 한, 브라우저와 무관하게 동작) ----------

def scheduler_loop():
    last_run_key = None
    while True:
        try:
            settings = load_settings()
            target = settings.get("dailyCheckTime", "09:00")
            now = datetime.now()
            current_hm = now.strftime("%H:%M")
            run_key = f"{now.date()}T{current_hm}"
            if current_hm == target and run_key != last_run_key:
                last_run_key = run_key
                check_all_sites()
        except Exception:
            pass
        time.sleep(5)


# ---------- 목업 게시판 렌더링 (서버 사이드) ----------

def escape_html(s):
    return (
        str(s)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


BOARD_TEMPLATE = """<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>정보대학 공지사항 (목업)</title>
<link rel="stylesheet" href="../style.css">
</head>
<body>
<div class="wrap">
  <header class="app-header">
    <h1>📋 정보대학 공지사항 (목업)</h1>
    <span class="sub">데모용으로 만든 가짜 게시판입니다 (서버 렌더링)</span>
  </header>

  <div class="board-toolbar">
    <button class="secondary" onclick="location.href='../index.html'">감지 웹앱으로 돌아가기</button>
    <button onclick="location.href='write.html'">글쓰기</button>
  </div>

  <section class="panel">
    <div class="table-scroll">
      <table class="w">
        <thead>
          <tr>
            <th scope="col">번호</th>
            <th scope="col">제목</th>
            <th scope="col">작성자</th>
            <th scope="col">등록일</th>
          </tr>
        </thead>
        <tbody>
{rows}
        </tbody>
      </table>
    </div>
  </section>
</div>
</body>
</html>
"""

ROW_TEMPLATE = """      <tr>
        <td>{id}</td>
        <td class="txt_left">
          <div class="b-title-box">
            <a class="article-title" href="#">{title}</a>
          </div>
        </td>
        <td>{author}</td>
        <td>{date}</td>
      </tr>"""


def render_board_html():
    notices = sorted(load_notices(), key=lambda n: n["id"], reverse=True)
    rows = "\n".join(
        ROW_TEMPLATE.format(
            id=n["id"],
            title=escape_html(n["title"]),
            author=escape_html(n["author"]),
            date=escape_html(n["date"]),
        )
        for n in notices
    )
    return BOARD_TEMPLATE.format(rows=rows)


# ---------- HTTP 핸들러 ----------

class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def _send_json(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        body = self.rfile.read(length)
        try:
            return json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            raise ValueError(f"잘못된 요청 본문입니다 (UTF-8 JSON이어야 함): {e}")

    def _path_parts(self):
        parsed = urllib.parse.urlparse(self.path)
        return parsed.path, [p for p in parsed.path.split("/") if p], urllib.parse.parse_qs(parsed.query)

    def do_GET(self):
        self._safe(self._handle_GET)

    def do_POST(self):
        self._safe(self._handle_POST)

    def do_PUT(self):
        self._safe(self._handle_PUT)

    def do_DELETE(self):
        self._safe(self._handle_DELETE)

    def _safe(self, fn):
        try:
            fn()
        except Exception as e:
            try:
                self._send_json(400, {"ok": False, "error": str(e)})
            except Exception:
                pass

    # ---- GET ----
    def _handle_GET(self):
        path, parts, qs = self._path_parts()

        if path == "/board/index.html" or path == "/board/":
            html = render_board_html().encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(html)))
            self.end_headers()
            self.wfile.write(html)
            return

        if path == "/api/sites":
            self._send_json(200, load_sites())
            return

        if path == "/api/settings":
            self._send_json(200, load_settings())
            return

        if path == "/api/crawl":
            target = (qs.get("url") or [None])[0]
            if not target:
                self._send_json(400, {"ok": False, "error": "url parameter required"})
                return
            try:
                titles = validate_and_crawl(target)
                self._send_json(200, {"ok": True, "titles": titles})
            except CrawlError as e:
                self._send_json(502, {"ok": False, "error": str(e)})
            return

        self.serve_static(path)

    # ---- POST ----
    def _handle_POST(self):
        path, parts, qs = self._path_parts()

        if path == "/api/sites":
            body = self._read_json_body()
            alias = (body.get("alias") or "").strip()
            url = (body.get("url") or "").strip()
            keywords = [k.strip() for k in body.get("keywords", []) if k.strip()]
            if not alias or not url:
                self._send_json(400, {"ok": False, "error": "alias, url은 필수입니다."})
                return
            try:
                titles = validate_and_crawl(url)
            except CrawlError as e:
                self._send_json(400, {"ok": False, "error": str(e)})
                return
            site = {
                "id": uuid.uuid4().hex[:10],
                "alias": alias,
                "url": url,
                "keywords": keywords,
                "lastTitles": titles,
                "status": f"기준 상태 저장됨 ({len(titles)}건) — {korean_time_str(datetime.now())}",
                "triggered": False,
            }
            sites = load_sites()
            sites.append(site)
            save_sites(sites)
            self._send_json(201, site)
            return

        # /api/sites/<id>/check
        if len(parts) == 4 and parts[:2] == ["api", "sites"] and parts[3] == "check":
            site_id = parts[2]
            sites = load_sites()
            site = next((s for s in sites if s["id"] == site_id), None)
            if not site:
                self._send_json(404, {"ok": False, "error": "not found"})
                return
            perform_check(site)
            save_sites(sites)
            self._send_json(200, site)
            return

        # /api/sites/<id>/clear
        if len(parts) == 4 and parts[:2] == ["api", "sites"] and parts[3] == "clear":
            site_id = parts[2]
            sites = load_sites()
            site = next((s for s in sites if s["id"] == site_id), None)
            if not site:
                self._send_json(404, {"ok": False, "error": "not found"})
                return
            site["triggered"] = False
            save_sites(sites)
            self._send_json(200, site)
            return

        if path == "/api/board/notices":
            body = self._read_json_body()
            title = (body.get("title") or "").strip()
            author = (body.get("author") or "정보대학행정팀").strip()
            if not title:
                self._send_json(400, {"ok": False, "error": "title은 필수입니다."})
                return
            notices = load_notices()
            next_id = (max((n["id"] for n in notices), default=0)) + 1
            today = datetime.now().strftime("%Y.%m.%d")
            notices.insert(0, {"id": next_id, "title": title, "author": author, "date": today})
            save_notices(notices)
            self._send_json(201, {"ok": True})
            return

        self.send_error(404)

    # ---- PUT ----
    def _handle_PUT(self):
        path, parts, qs = self._path_parts()

        # /api/sites/<id>
        if len(parts) == 3 and parts[:2] == ["api", "sites"]:
            site_id = parts[2]
            body = self._read_json_body()
            sites = load_sites()
            site = next((s for s in sites if s["id"] == site_id), None)
            if not site:
                self._send_json(404, {"ok": False, "error": "not found"})
                return
            if "keywords" in body:
                site["keywords"] = [k.strip() for k in body["keywords"] if k.strip()]
            save_sites(sites)
            self._send_json(200, site)
            return

        if path == "/api/settings":
            body = self._read_json_body()
            time_value = (body.get("dailyCheckTime") or "").strip()
            if not re.match(r"^\d{2}:\d{2}$", time_value):
                self._send_json(400, {"ok": False, "error": "HH:MM 형식이어야 합니다."})
                return
            settings = load_settings()
            settings["dailyCheckTime"] = time_value
            save_settings(settings)
            self._send_json(200, settings)
            return

        self.send_error(404)

    # ---- DELETE ----
    def _handle_DELETE(self):
        path, parts, qs = self._path_parts()

        # /api/sites/<id>
        if len(parts) == 3 and parts[:2] == ["api", "sites"]:
            site_id = parts[2]
            sites = load_sites()
            new_sites = [s for s in sites if s["id"] != site_id]
            save_sites(new_sites)
            self._send_json(200, {"ok": True})
            return

        self.send_error(404)

    # ---- 정적 파일 ----
    def serve_static(self, path):
        if path == "/":
            path = "/index.html"
        file_path = os.path.normpath(os.path.join(ROOT, path.lstrip("/")))
        if not file_path.startswith(ROOT) or not os.path.isfile(file_path):
            self.send_error(404)
            return
        ext = os.path.splitext(file_path)[1]
        content_type = CONTENT_TYPES.get(ext, "application/octet-stream")
        with open(file_path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def lan_ip():
    """이 PC가 같은 와이파이의 다른 기기(휴대폰 등)에 보여주는 IP를 추정한다."""
    import socket

    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))  # 실제로 데이터를 보내지 않음, 라우팅 확인용
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


if __name__ == "__main__":
    threading.Thread(target=scheduler_loop, daemon=True).start()
    # 0.0.0.0으로 열어야 같은 와이파이의 휴대폰 등 다른 기기에서도 접속할 수 있다.
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Serving on {BASE_URL} (자동 확인 스케줄러 동작 중)")
    ip = lan_ip()
    if ip:
        print(f"같은 와이파이의 휴대폰/다른 기기에서는: http://{ip}:{PORT}/index.html")
    httpd.serve_forever()
