import gzip
import html
import json
import os
import re
import sys
import time
import unicodedata
import xml.etree.ElementTree as ET
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from difflib import SequenceMatcher
from html.parser import HTMLParser
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

for stream_name in ("stdin", "stdout", "stderr"):
    try:
        getattr(sys, stream_name).reconfigure(encoding="utf-8")
    except Exception:
        pass

try:
    from ytmusicapi import YTMusic
except Exception:
    YTMusic = None


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
PAXSENIX_TOKEN_FILE = os.path.join(ROOT_DIR, "paxsenix_token.txt")

APPLE_SEARCH_API = "https://lyrics.paxsenix.org/apple-music/search"
APPLE_LYRICS_API = "https://lyrics.paxsenix.org/apple-music/lyrics"
QQ_LYRICS_API = "https://lyrics.paxsenix.org/qq/lyrics-metadata"
UTATEN_SEARCH_API = "https://utaten.com/lyric/search"

PROVIDER_ORDER = ["ytmusic", "apple_music", "qq_music"]
WORDLIKE_TYPES = {"word", "syllable", "character", "verbatim"}
UTATEN_LINE_MERGE_LIMIT = 6
UTATEN_SOURCE_LINE_MERGE_LIMIT = 4
UTATEN_GLOBAL_RATIO_THRESHOLD = 0.74
UTATEN_COVERAGE_THRESHOLD = 0.72
UTATEN_MATCHED_LINE_RATIO_THRESHOLD = 0.55
UTATEN_MIN_MATCHED_LINES = 4
UTATEN_MIN_LINE_SIMILARITY = 0.5

UTATEN_STRONG_MATCH_COVERAGE = 0.9
UTATEN_STRONG_MATCH_GLOBAL_RATIO = 0.86
UTATEN_STRONG_MATCHED_LINE_RATIO = 0.72
UTATEN_SEARCH_CANDIDATES_PER_STEP = 3
UTATEN_SEARCH_REQUEST_TIMEOUT = 4.0
UTATEN_PAGE_REQUEST_TIMEOUT = 5.0
UTATEN_SEARCH_WORKERS = 3
UTATEN_PAGE_FETCH_WORKERS = 4
UTATEN_PREVIEW_SOURCE_LINE_LIMIT = 6
UTATEN_PREVIEW_CANDIDATE_LINE_LIMIT = 12
UTATEN_PREVIEW_ALIGNMENT_OPTIONS = {
    "lineMergeLimit": 4,
    "sourceLineMergeLimit": 4,
    "globalRatioThreshold": 0.68,
    "coverageThreshold": 0.68,
    "matchedLineRatioThreshold": 0.55,
    "minMatchedLines": 3,
    "minLineSimilarity": 0.46,
}
UTATEN_NO_RESULT_MARKERS = (
    "ごめんなさい。歌詞が見つかりませんでした。",
    "ごめんなさい。歌詞が見つかりませんでした",
    "歌詞が見つかりませんでした",
)
LOOKUP_DEADLINE_WITH_UTATEN_SECONDS = 40.0
LOOKUP_DEADLINE_SECONDS = 27.0
BAD_TITLE_TERMS = (
    "instrumental",
    "karaoke",
    "originally performed",
    "tribute",
    "cover",
    "伴奏",
    "卡拉ok",
)
CREDIT_PREFIXES = (
    "作词",
    "作曲",
    "编曲",
    "制作",
    "监制",
    "词：",
    "曲：",
    "编：",
    "lyrics by",
    "written by",
    "music by",
    "composed by",
    "arranged by",
    "produced by",
)


def normalize_space(value):
    return " ".join(str(value or "").split()).strip()


def strip_decorators(value):
    text = normalize_space(value)
    text = re.sub(r"[【\[].*?(歌词|歌詞|lyric|lyrics|official|mv|m/v|video|audio|karaoke|中字|中日字幕|中字版|4k|hd).*?[】\]]", " ", text, flags=re.I)
    text = re.sub(r"\((?:[^)(]*(歌词|歌詞|lyric|lyrics|official|mv|m/v|video|audio|karaoke|中字|中日字幕|中字版|4k|hd)[^)(]*)\)", " ", text, flags=re.I)
    text = re.sub(r"(?:^|\s)-\s*(official|mv|m/v|video|audio|lyrics?|karaoke)\b.*$", " ", text, flags=re.I)
    text = re.sub(r"[|｜].*$", " ", text)
    return normalize_space(text)


def normalize_key(value):
    text = strip_decorators(value).lower()
    return re.sub(r"[^0-9a-z\u4e00-\u9fff\u3040-\u30ff]+", "", text, flags=re.I)


def parse_duration_seconds(value, milliseconds=False):
    try:
        numeric = float(value)
    except Exception:
        return None
    if not numeric:
        return None
    if milliseconds:
        numeric /= 1000.0
    return int(round(numeric))


def to_seconds(value):
    try:
        return round(float(value) / 1000.0, 3)
    except Exception:
        return None


def is_cjk_like_char(value):
    return bool(re.match(r"[\u4e00-\u9fff\u3040-\u30ff]", value or ""))


def local_name(value):
    text = str(value or "")
    if "}" in text:
        return text.split("}", 1)[1]
    if ":" in text:
        return text.split(":", 1)[1]
    return text


def normalize_xml_name(value):
    return re.sub(r"[^a-z0-9]+", "", local_name(value).lower())


def normalize_inline_text(value):
    text = str(value or "")
    if not text:
        return ""
    if text.isspace():
        return "" if re.search(r"[\r\n\t]", text) else " "
    return text


def get_xml_attr(element, *names):
    if element is None or not hasattr(element, "attrib"):
        return None
    wanted = {normalize_xml_name(name) for name in names if name}
    for key, value in element.attrib.items():
        if normalize_xml_name(key) in wanted and value is not None:
            return str(value)
    return None


def parse_clock_time(value):
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("s") and re.match(r"^\d+(?:\.\d+)?s$", text):
        try:
            return round(float(text[:-1]), 3)
        except Exception:
            return None
    try:
        if ":" not in text:
            return round(float(text), 3)
        parts = text.split(":")
        if len(parts) == 2:
            minutes = int(parts[0])
            seconds = float(parts[1])
            return round((minutes * 60) + seconds, 3)
        if len(parts) == 3:
            hours = int(parts[0])
            minutes = int(parts[1])
            seconds = float(parts[2])
            return round((hours * 3600) + (minutes * 60) + seconds, 3)
    except Exception:
        return None
    return None


def has_timed_descendants(node):
    for child in (list(node) if node is not None else []):
        if parse_clock_time(get_xml_attr(child, "begin")) is not None:
            return True
        if has_timed_descendants(child):
            return True
    return False


def make_ttml_bucket_key(track_type="main", lang=None, background=False, source="inline", track_subtype=None):
    return (
        normalize_space(track_type) or "main",
        normalize_space(lang) or None,
        bool(background),
        normalize_space(source) or "inline",
        normalize_space(track_subtype) or None,
    )


def append_ttml_bucket_event(buckets, key, text, start=None, end=None, agent_id=None, timed=False):
    if text is None:
        return
    text = str(text)
    if not text:
        return
    buckets.setdefault(key, []).append({
        "text": text,
        "start": start,
        "end": end,
        "agent": agent_id,
        "timed": bool(timed),
    })


def collect_ttml_track_events(node, track_type="main", lang=None, background=False, source="inline", track_subtype=None, agent_id=None, buckets=None):
    if buckets is None:
        buckets = {}

    bucket_key = make_ttml_bucket_key(track_type, lang, background, source, track_subtype)
    text = normalize_inline_text(getattr(node, "text", ""))
    if text:
        append_ttml_bucket_event(buckets, bucket_key, text, agent_id=agent_id, timed=False)

    for child in (list(node) if node is not None else []):
        role = normalize_xml_name(get_xml_attr(child, "role"))
        child_track_type = track_type
        child_lang = lang
        child_background = background
        child_source = source
        child_track_subtype = track_subtype
        if role == "xbg":
            child_background = True
        elif role == "xtranslation":
            child_track_type = "translation"
            child_lang = get_xml_attr(child, "lang") or child_lang
            child_source = "inline"
        elif role == "xroman":
            child_track_type = "roman"
            child_lang = get_xml_attr(child, "lang") or child_lang
            child_source = "inline"

        child_agent = get_xml_attr(child, "agent") or agent_id
        child_start = parse_clock_time(get_xml_attr(child, "begin"))
        child_end = parse_clock_time(get_xml_attr(child, "end"))
        is_leaf_timed_span = local_name(child.tag) == "span" and child_start is not None and not list(child)
        child_bucket_key = make_ttml_bucket_key(child_track_type, child_lang, child_background, child_source, child_track_subtype)

        if is_leaf_timed_span:
            token_text = normalize_inline_text("".join(child.itertext()))
            if token_text:
                append_ttml_bucket_event(
                    buckets,
                    child_bucket_key,
                    token_text,
                    start=child_start,
                    end=child_end,
                    agent_id=child_agent,
                    timed=True,
                )
        else:
            collect_ttml_track_events(
                child,
                track_type=child_track_type,
                lang=child_lang,
                background=child_background,
                source=child_source,
                track_subtype=child_track_subtype,
                agent_id=child_agent,
                buckets=buckets,
            )

        tail = normalize_inline_text(getattr(child, "tail", ""))
        if tail:
            append_ttml_bucket_event(buckets, bucket_key, tail, agent_id=agent_id, timed=False)

    return buckets


def build_words_from_bucket_events(events):
    words = []
    pending_prefix = ""
    for event in events or []:
        text = str(event.get("text") or "")
        if not event.get("timed"):
            pending_prefix += text
            continue
        token_text = f"{pending_prefix}{text}"
        pending_prefix = ""
        if not token_text or token_text.isspace():
            continue
        next_word = {
            "text": token_text,
            "start": event.get("start"),
            "end": event.get("end"),
        }
        if event.get("agent"):
            next_word["agent"] = event.get("agent")
        words.append(next_word)
    if pending_prefix and words:
        words[-1]["text"] = f"{words[-1]['text']}{pending_prefix}"
    return words


def build_plain_text_from_bucket_events(events):
    text = "".join(str(event.get("text") or "") for event in (events or []))
    return normalize_space(text)


def build_track_content_from_bucket_events(events, fallback_start=None, fallback_end=None):
    words = build_words_from_bucket_events(events)
    text = "".join(word["text"] for word in words).strip() if words else build_plain_text_from_bucket_events(events)
    if not text:
        return None
    start = fallback_start
    end = fallback_end
    if words:
        if start is None:
            start = words[0].get("start")
        if end is None:
            end = words[-1].get("end")
    return {
        "text": text,
        "words": words or None,
        "start": start,
        "end": end,
        "timing": "word" if words else "line",
    }


def build_auxiliary_track_entries(buckets, fallback_start=None, fallback_end=None):
    grouped = {}
    for key, events in (buckets or {}).items():
        track_type, lang, background, source, track_subtype = key
        if track_type not in {"translation", "roman"}:
            continue
        grouped.setdefault((track_type, lang, source, track_subtype), {})["background" if background else "main"] = events

    tracks = []
    for (track_type, lang, source, track_subtype), group in grouped.items():
        main_content = build_track_content_from_bucket_events(group.get("main"), fallback_start=fallback_start, fallback_end=fallback_end)
        background_content = build_track_content_from_bucket_events(group.get("background"), fallback_start=fallback_start, fallback_end=fallback_end)
        if not main_content and not background_content:
            continue
        track = {
            "role": track_type,
            "lang": lang,
            "source": source,
            "type": track_subtype,
            "timing": "word" if ((main_content and main_content.get("words")) or (background_content and background_content.get("words"))) else "line",
            "text": main_content.get("text") if main_content else "",
            "words": main_content.get("words") if main_content else None,
            "backgroundText": background_content.get("text") if background_content else "",
            "backgroundWords": background_content.get("words") if background_content else None,
        }
        if main_content and main_content.get("start") is not None:
            track["start"] = main_content.get("start")
        if main_content and main_content.get("end") is not None:
            track["end"] = main_content.get("end")
        if background_content and background_content.get("start") is not None:
            track["backgroundStart"] = background_content.get("start")
        if background_content and background_content.get("end") is not None:
            track["backgroundEnd"] = background_content.get("end")
        tracks.append(track)
    return tracks


def extract_line_agent(words, default_agent=None):
    if default_agent:
        return default_agent
    unique_agents = []
    for word in words or []:
        agent_id = normalize_space(word.get("agent"))
        if agent_id and agent_id not in unique_agents:
            unique_agents.append(agent_id)
    return unique_agents[0] if len(unique_agents) == 1 else None


def normalize_word_entries(words, fallback_end):
    normalized_words = []
    for word in words or []:
        start = word.get("start")
        if start is None or word.get("text") is None:
            continue
        end = word.get("end")
        if end is None or end <= start:
            end = fallback_end
        normalized_word = {
            "text": str(word.get("text")),
            "start": round(float(start), 3),
            "end": round(float(end), 3),
        }
        for key, value in word.items():
            if key in {"text", "start", "end"} or value is None:
                continue
            normalized_word[key] = value
        normalized_words.append(normalized_word)
    normalized_words.sort(key=lambda item: item["start"])
    return normalized_words or None


def load_paxsenix_token():
    token = normalize_space(os.getenv("PAXSENIX_API_TOKEN"))
    if token:
        return token
    if os.path.exists(PAXSENIX_TOKEN_FILE):
        try:
            return normalize_space(open(PAXSENIX_TOKEN_FILE, "r", encoding="utf-8").read())
        except Exception:
            return ""
    return ""


PAXSENIX_API_TOKEN = load_paxsenix_token()


def read_response_body(response, body):
    encoding = (response.headers.get("Content-Encoding") or "").lower()
    if encoding == "gzip":
        try:
            body = gzip.decompress(body)
        except Exception:
            pass
    return body.decode("utf-8", errors="replace")


def get_deadline_remaining(deadline_at):
    if deadline_at is None:
        return None
    return deadline_at - time.monotonic()


def is_deadline_exceeded(deadline_at, reserve_seconds=0.0):
    remaining = get_deadline_remaining(deadline_at)
    return remaining is not None and remaining <= reserve_seconds


def get_bounded_timeout(default_timeout, deadline_at, minimum_timeout=1.0, reserve_seconds=0.75):
    remaining = get_deadline_remaining(deadline_at)
    if remaining is None:
        return default_timeout
    usable = remaining - reserve_seconds
    if usable <= minimum_timeout:
        raise TimeoutError("lookup_deadline_exceeded")
    return min(default_timeout, usable)


def request_json(url, params=None, method="GET", data=None, headers=None, timeout=10.0, retries=2, deadline_at=None):
    final_url = url
    if params:
        final_url = f"{url}?{urlencode(params, doseq=True)}"

    body = None
    request_headers = {
        "User-Agent": "local-karaoke-system/1.0",
        "Accept": "application/json, text/plain;q=0.9, */*;q=0.8",
    }
    if headers:
        request_headers.update(headers)
    if method.upper() == "POST":
        request_headers.setdefault("Content-Type", "application/json")
        body = json.dumps(data or {}, ensure_ascii=False).encode("utf-8")

    last_error = None
    for attempt in range(retries + 1):
        bounded_timeout = get_bounded_timeout(timeout, deadline_at)
        request = Request(final_url, data=body, headers=request_headers, method=method.upper())
        try:
            with urlopen(request, timeout=bounded_timeout) as response:
                text = read_response_body(response, response.read())
                return json.loads(text) if text else None
        except HTTPError as error:
            text = ""
            try:
                text = read_response_body(error, error.read())
            except Exception:
                pass
            last_error = RuntimeError(f"http_{error.code}:{text[:400]}")
            if error.code in (429, 500, 502, 503, 504) and attempt < retries:
                time.sleep(0.5 * (attempt + 1))
                continue
            raise last_error
        except (URLError, TimeoutError, ValueError) as error:
            last_error = error
            if attempt < retries:
                time.sleep(0.5 * (attempt + 1))
                continue
            raise
    raise last_error or RuntimeError("request_failed")


def request_text(url, params=None, method="GET", data=None, headers=None, timeout=10.0, retries=2, deadline_at=None):
    final_url = url
    if params:
        final_url = f"{url}?{urlencode(params, doseq=True)}"

    body = None
    request_headers = {
        "User-Agent": "local-karaoke-system/1.0",
        "Accept": "text/html, application/xhtml+xml, application/xml;q=0.9, text/plain;q=0.8, */*;q=0.7",
    }
    if headers:
        request_headers.update(headers)
    if method.upper() == "POST":
        request_headers.setdefault("Content-Type", "application/json")
        body = json.dumps(data or {}, ensure_ascii=False).encode("utf-8")

    last_error = None
    for attempt in range(retries + 1):
        bounded_timeout = get_bounded_timeout(timeout, deadline_at)
        request = Request(final_url, data=body, headers=request_headers, method=method.upper())
        try:
            with urlopen(request, timeout=bounded_timeout) as response:
                return read_response_body(response, response.read())
        except HTTPError as error:
            text = ""
            try:
                text = read_response_body(error, error.read())
            except Exception:
                pass
            last_error = RuntimeError(f"http_{error.code}:{text[:400]}")
            if error.code in (429, 500, 502, 503, 504) and attempt < retries:
                time.sleep(0.5 * (attempt + 1))
                continue
            raise last_error
        except (URLError, TimeoutError, ValueError) as error:
            last_error = error
            if attempt < retries:
                time.sleep(0.5 * (attempt + 1))
                continue
            raise
    raise last_error or RuntimeError("request_failed")


def build_search_query(query):
    return normalize_space(" ".join(part for part in [query.get("track"), query.get("artist")] if part))


def score_candidate(track, artist, album, duration, query):
    normalized_track = normalize_key(track)
    normalized_artist = normalize_key(artist)
    normalized_album = normalize_key(album)
    query_track = normalize_key(query.get("track"))
    query_artist = normalize_key(query.get("artist"))
    query_album = normalize_key(query.get("album"))

    score = 0
    if query_track:
        if normalized_track == query_track:
            score += 90
        elif normalized_track.startswith(query_track) or query_track.startswith(normalized_track):
            score += 60
        elif query_track in normalized_track or normalized_track in query_track:
            score += 40

    if query_artist:
        if normalized_artist == query_artist:
            score += 55
        elif query_artist in normalized_artist or normalized_artist in query_artist:
            score += 30

    if query_album and normalized_album:
        if normalized_album == query_album:
            score += 20
        elif query_album in normalized_album or normalized_album in query_album:
            score += 10

    query_duration = query.get("duration")
    if query_duration and duration:
        delta = abs(int(query_duration) - int(duration))
        if delta <= 2:
            score += 30
        elif delta <= 5:
            score += 18
        elif delta <= 10:
            score += 8

    combined = f"{track} {artist}".lower()
    query_text = f"{query.get('track', '')} {query.get('artist', '')}".lower()
    for term in BAD_TITLE_TERMS:
        if term in combined and term not in query_text:
            score -= 45

    return score


def is_credit_like_text(text, query, start):
    cleaned = normalize_space(text)
    if not cleaned:
        return True
    lowered = cleaned.lower()
    if any(lowered.startswith(prefix) for prefix in CREDIT_PREFIXES if prefix.isascii()):
        return True
    if any(cleaned.startswith(prefix) for prefix in CREDIT_PREFIXES if not prefix.isascii()):
        return True
    if start is not None and start <= 20:
        normalized = normalize_key(cleaned)
        title_key = normalize_key(query.get("track"))
        artist_key = normalize_key(query.get("artist"))
        if title_key and normalized == title_key:
            return True
        if artist_key and normalized == artist_key:
            return True
        if title_key and artist_key and title_key in normalized and artist_key in normalized:
            return True
    return False


def clean_lines(lines, query, preserve_symbol_only=False):
    cleaned = []
    dropped_intro = 0
    for line in lines:
        text = normalize_space(line.get("text"))
        if not text:
            continue
        if not preserve_symbol_only and re.fullmatch(r"[♪♩♫♬♭♯・·•\s]+", text):
            continue
        next_line = {
            "text": text,
            "start": line.get("start"),
            "end": line.get("end"),
            "words": line.get("words"),
        }
        if line.get("backgroundText"):
            next_line["backgroundText"] = normalize_space(line.get("backgroundText"))
        if line.get("backgroundWords"):
            next_line["backgroundWords"] = line.get("backgroundWords")
        for key, value in line.items():
            if key in {"text", "start", "end", "words", "backgroundText", "backgroundWords"} or value is None:
                continue
            next_line[key] = value
        if is_credit_like_text(text, query, next_line["start"]) and not cleaned and dropped_intro < 4:
            dropped_intro += 1
            continue
        cleaned.append(next_line)
    return cleaned


def is_japanese_char(char):
    return bool(re.match(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff々〆ヵヶ]", char or ""))


def count_japanese_chars(text):
    return sum(1 for char in str(text or "") if is_japanese_char(char))


def contains_japanese_text(text):
    return count_japanese_chars(text) > 0


def normalize_utaten_match_text(value):
    text = html.unescape(str(value or ""))
    text = unicodedata.normalize("NFKC", text).lower()
    text = normalize_space(text)
    text = re.sub(r"[`'\"“”‘’「」『』（）()［］\[\]【】〔〕〈〉《》＜＞｢｣…‥・･、。，．！？!?,.:;~〜\-—―_/\s]+", "", text)
    return re.sub(r"[^0-9a-z\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff々〆ヵヶ]", "", text)


def normalize_utaten_html_text(value):
    text = str(value or "").replace("\xa0", " ")
    if not text or text.isspace():
        return ""
    return normalize_space(text)


def smart_join_romaji_segments(segments):
    joined = ""
    for raw_segment in segments or []:
        segment = normalize_space(raw_segment)
        if not segment:
            continue
        if not joined:
            joined = segment
            continue
        if re.search(r"[a-z0-9]$", joined, flags=re.I) and re.match(r"^[a-z0-9]", segment, flags=re.I):
            joined = f"{joined} {segment}"
            continue
        joined = f"{joined}{segment}"
    return normalize_space(joined)


class UtatenSearchResultsParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.results = []
        self.current_href = None
        self.current_text_parts = []

    def handle_starttag(self, tag, attrs):
        if tag.lower() != "a":
            return
        attr_map = {str(key): str(value) for key, value in attrs if key}
        href = str(attr_map.get("href") or "")
        if not re.match(r"^/lyric/[^/]+/$", href):
            return
        self.current_href = href
        self.current_text_parts = []

    def handle_data(self, data):
        if self.current_href is not None:
            self.current_text_parts.append(str(data or ""))

    def handle_endtag(self, tag):
        if tag.lower() != "a" or self.current_href is None:
            return
        link_text = normalize_space("".join(self.current_text_parts))
        self.results.append({
            "href": self.current_href,
            "text": link_text,
        })
        self.current_href = None
        self.current_text_parts = []


class UtatenRomajiPageParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.romaji_depth = 0
        self.element_role_stack = []
        self.current_token = None
        self.current_line_base_parts = []
        self.current_line_romaji_parts = []
        self.current_line_tokens = []
        self.lines = []

    def handle_starttag(self, tag, attrs):
        attr_map = {str(key): str(value) for key, value in attrs if key}
        class_names = set(str(attr_map.get("class") or "").split())
        role = None
        if "romaji" in class_names:
            self.romaji_depth += 1
            role = "romaji"
        if self.romaji_depth <= 0:
            return
        if tag.lower() == "br":
            self.flush_line()
            return
        if "ruby" in class_names:
            role = "ruby"
            if self.current_token is None:
                self.current_token = {"base_parts": [], "romaji_parts": []}
        elif "rb" in class_names:
            role = "rb"
        elif "rt" in class_names:
            role = "rt"
        self.element_role_stack.append(role)

    def handle_startendtag(self, tag, attrs):
        if tag.lower() == "br" and self.romaji_depth > 0:
            self.flush_line()

    def handle_endtag(self, tag):
        if self.romaji_depth <= 0 or not self.element_role_stack:
            return
        popped_role = self.element_role_stack.pop()
        if popped_role == "ruby":
            self.flush_token()
        if popped_role == "romaji":
            self.romaji_depth -= 1
            if self.romaji_depth == 0:
                self.flush_token()
                self.flush_line()

    def handle_data(self, data):
        if self.romaji_depth <= 0:
            return
        text = normalize_utaten_html_text(data)
        if not text:
            return
        if self.current_token is not None:
            current_role = None
            for role in reversed(self.element_role_stack):
                if role is not None:
                    current_role = role
                    break
            if current_role == "rt":
                self.current_token["romaji_parts"].append(text)
                return
            if current_role in {"rb", "ruby"}:
                self.current_token["base_parts"].append(text)
                return
        self.current_line_tokens.append({
            "base": text,
            "romaji": text,
        })
        self.current_line_base_parts.append(text)
        self.current_line_romaji_parts.append(text)

    def flush_token(self):
        if self.current_token is None:
            return
        base = normalize_space("".join(self.current_token.get("base_parts") or []))
        romaji = normalize_space("".join(self.current_token.get("romaji_parts") or []))
        if base or romaji:
            next_token = {
                "base": base,
                "romaji": romaji or base,
            }
            self.current_line_tokens.append(next_token)
            if base:
                self.current_line_base_parts.append(base)
            if next_token["romaji"]:
                self.current_line_romaji_parts.append(next_token["romaji"])
        self.current_token = None

    def flush_line(self):
        base = normalize_space("".join(self.current_line_base_parts))
        romaji = smart_join_romaji_segments(self.current_line_romaji_parts)
        if base:
            self.lines.append({
                "base": base,
                "romaji": romaji or base,
                "tokens": list(self.current_line_tokens),
                "norm": normalize_utaten_match_text(base),
            })
        self.current_line_base_parts = []
        self.current_line_romaji_parts = []
        self.current_line_tokens = []


def is_source_lyrics_eligible_for_utaten(lines):
    japanese_lines = 0
    japanese_chars = 0
    for line in lines or []:
        text = normalize_space(line.get("text"))
        line_count = count_japanese_chars(text)
        if line_count > 0:
            japanese_lines += 1
            japanese_chars += line_count
    return japanese_lines >= 2 and japanese_chars >= 8


def select_utaten_body_search_line(lines, query):
    for line in lines or []:
        text = normalize_space(line.get("text"))
        if count_japanese_chars(text) < 4:
            continue
        if is_credit_like_text(text, query, 0):
            continue
        if re.fullmatch(r"[♪♩♫♬♭♯・·•\s]+", text):
            continue
        return text
    return ""


def strip_html_tags(value):
    return re.sub(r"<[^>]+>", " ", str(value or ""))


def is_utaten_search_miss_page(page_text):
    normalized_text = normalize_space(html.unescape(strip_html_tags(page_text or "")))
    return any(marker in normalized_text for marker in UTATEN_NO_RESULT_MARKERS)


def parse_utaten_search_results(page_text):
    if is_utaten_search_miss_page(page_text):
        return []
    parser = UtatenSearchResultsParser()
    parser.feed(page_text or "")
    parser.close()
    results = []
    seen_hrefs = set()
    for item in parser.results:
        href = str(item.get("href") or "")
        if not href or href in seen_hrefs:
            continue
        seen_hrefs.add(href)
        lyric_match = re.search(r"/lyric/([^/]+)/$", href)
        results.append({
            "lyricId": lyric_match.group(1) if lyric_match else None,
            "url": f"https://utaten.com{href}",
            "text": normalize_space(item.get("text")),
        })
    return results


def build_utaten_search_steps(query, source_lines):
    body_line = select_utaten_body_search_line(source_lines, query)
    raw_search_steps = [
        ("artist_title", {"artist_name": query.get("artist") or "", "title": query.get("track") or ""}),
        ("title", {"title": query.get("track") or ""}),
        ("body", {"body": body_line}),
    ]
    search_steps = []
    for priority, (search_mode, params) in enumerate(raw_search_steps):
        filtered_params = {key: value for key, value in params.items() if normalize_space(value)}
        if not filtered_params:
            continue
        search_steps.append({
            "searchMode": search_mode,
            "params": filtered_params,
            "priority": priority,
        })
    return search_steps


def fetch_utaten_search_step_candidates(step, deadline_at=None):
    if not step:
        return []
    if is_deadline_exceeded(deadline_at, 1.5):
        return []
    try:
        page_text = request_text(
            UTATEN_SEARCH_API,
            params=step.get("params"),
            timeout=UTATEN_SEARCH_REQUEST_TIMEOUT,
            retries=0,
            deadline_at=deadline_at,
        )
    except Exception:
        return []
    if is_utaten_search_miss_page(page_text):
        return []

    candidates = []
    for search_rank, item in enumerate(parse_utaten_search_results(page_text)):
        next_candidate = dict(item)
        next_candidate["searchMode"] = step.get("searchMode")
        next_candidate["searchPriority"] = step.get("priority", 99)
        next_candidate["searchRank"] = search_rank
        candidates.append(next_candidate)
        if len(candidates) >= UTATEN_SEARCH_CANDIDATES_PER_STEP:
            break
    return candidates


def fetch_utaten_romaji_page(url, deadline_at=None):
    try:
        page_text = request_text(url, timeout=UTATEN_PAGE_REQUEST_TIMEOUT, retries=0, deadline_at=deadline_at)
    except Exception:
        return None
    parser = UtatenRomajiPageParser()
    parser.feed(page_text or "")
    parser.close()
    lines = [line for line in parser.lines if line.get("norm")]
    if not lines:
        return None
    return {
        "url": url,
        "lines": lines,
        "fullNorm": "".join(line["norm"] for line in lines if line.get("norm")),
    }


def build_utaten_preview_source_lines(source_lines):
    preview_lines = []
    for line in source_lines or []:
        text = normalize_space(line.get("text"))
        if not text or count_japanese_chars(text) <= 0:
            continue
        preview_lines.append({
            "index": line.get("index"),
            "text": text,
        })
        if len(preview_lines) >= UTATEN_PREVIEW_SOURCE_LINE_LIMIT:
            break
    return preview_lines


def build_utaten_preview_candidate_lines(utaten_lines, source_preview_lines):
    target_chars = sum(len(normalize_utaten_match_text(line.get("text"))) for line in source_preview_lines or [])
    if target_chars <= 0:
        return list(utaten_lines or [])[:UTATEN_PREVIEW_CANDIDATE_LINE_LIMIT]

    preview_lines = []
    collected_chars = 0
    for line in utaten_lines or []:
        preview_lines.append(line)
        collected_chars += len(line.get("norm") or "")
        if len(preview_lines) >= UTATEN_PREVIEW_CANDIDATE_LINE_LIMIT:
            break
        if collected_chars >= target_chars and len(preview_lines) >= min(4, len(source_preview_lines or [])):
            break
    return preview_lines


def score_utaten_alignment_candidate(source_norm, utaten_norm):
    if not source_norm or not utaten_norm:
        return 0.0
    if source_norm == utaten_norm:
        return 1.0
    ratio = SequenceMatcher(None, source_norm, utaten_norm).ratio()
    if source_norm in utaten_norm or utaten_norm in source_norm:
        containment = min(len(source_norm), len(utaten_norm)) / max(len(source_norm), len(utaten_norm))
        return max(ratio, min(0.98, 0.82 + containment * 0.16))
    return ratio


def combine_utaten_line_span(lines):
    span_lines = lines or []
    tokens = []
    base_parts = []
    romaji_parts = []
    for line in span_lines:
        tokens.extend(line.get("tokens") or [])
        base_parts.append(normalize_space(line.get("base")))
        romaji_parts.append(normalize_space(line.get("romaji")))
    base_text = "".join(part for part in base_parts if part)
    return {
        "base": base_text,
        "romaji": smart_join_romaji_segments(romaji_parts),
        "tokens": tokens,
        "norm": normalize_utaten_match_text(base_text),
    }


def source_line_requires_utaten(line):
    return count_japanese_chars(line.get("text")) > 0


def combine_source_line_span(lines):
    span_lines = lines or []
    text_parts = []
    norm_parts = []
    required_char_count = 0
    required_line_count = 0
    for line in span_lines:
        text = normalize_space(line.get("text"))
        norm = normalize_utaten_match_text(text)
        if text:
            text_parts.append(text)
        if norm:
            norm_parts.append(norm)
        if line.get("requiresRomaji") and norm:
            required_char_count += len(norm)
            required_line_count += 1
    return {
        "text": "".join(text_parts),
        "norm": "".join(norm_parts),
        "requiredCharCount": required_char_count,
        "requiredLineCount": required_line_count,
    }


def split_utaten_span_for_source_lines(source_lines, utaten_span):
    tokens = list(utaten_span.get("tokens") or [])
    allocations = {}
    token_index = 0

    for source_line in source_lines or []:
        source_norm = source_line.get("norm") or ""
        collected_tokens = []
        accumulated_norm = ""

        if not source_norm:
            allocations[source_line["index"]] = {
                "tokens": [],
                "base": "",
                "romaji": "",
                "norm": "",
            }
            continue

        while token_index < len(tokens):
            token = tokens[token_index]
            collected_tokens.append(token)
            accumulated_norm += normalize_utaten_match_text(token.get("base"))
            token_index += 1
            if accumulated_norm == source_norm:
                break
            if accumulated_norm and not source_norm.startswith(accumulated_norm):
                return None

        if accumulated_norm != source_norm:
            return None

        base_text = "".join(normalize_space(token.get("base")) for token in collected_tokens if normalize_space(token.get("base")))
        romaji_text = smart_join_romaji_segments(token.get("romaji") for token in collected_tokens)
        allocations[source_line["index"]] = {
            "tokens": collected_tokens,
            "base": base_text,
            "romaji": romaji_text,
            "norm": source_norm,
        }

    remaining_norm = "".join(normalize_utaten_match_text(token.get("base")) for token in tokens[token_index:])
    if remaining_norm:
        return None
    return allocations


def align_utaten_lines(source_lines, utaten_lines, options=None):
    settings = {
        "lineMergeLimit": UTATEN_LINE_MERGE_LIMIT,
        "sourceLineMergeLimit": UTATEN_SOURCE_LINE_MERGE_LIMIT,
        "globalRatioThreshold": UTATEN_GLOBAL_RATIO_THRESHOLD,
        "coverageThreshold": UTATEN_COVERAGE_THRESHOLD,
        "matchedLineRatioThreshold": UTATEN_MATCHED_LINE_RATIO_THRESHOLD,
        "minMatchedLines": UTATEN_MIN_MATCHED_LINES,
        "minLineSimilarity": UTATEN_MIN_LINE_SIMILARITY,
    }
    if isinstance(options, dict):
        settings.update({key: value for key, value in options.items() if value is not None})

    normalized_source_lines = []
    for line in source_lines or []:
        text = normalize_space(line.get("text"))
        normalized_source_lines.append({
            "index": line.get("index"),
            "text": text,
            "norm": normalize_utaten_match_text(text),
            "requiresRomaji": source_line_requires_utaten({"text": text}),
        })

    eligible_source_lines = [line for line in normalized_source_lines if line.get("norm")]
    required_source_lines = [line for line in eligible_source_lines if line.get("requiresRomaji")]
    if not eligible_source_lines or not utaten_lines:
        return {
            "accepted": False,
            "reason": "insufficient_alignment_input",
            "globalRatio": 0.0,
            "coverage": 0.0,
            "matchedLineCount": 0,
            "matchedLineRatio": 0.0,
            "matches": {},
        }

    source_full_norm = "".join(line["norm"] for line in eligible_source_lines)
    utaten_full_norm = "".join(line.get("norm") or "" for line in utaten_lines)
    if not source_full_norm or not utaten_full_norm:
        return {
            "accepted": False,
            "reason": "insufficient_alignment_input",
            "globalRatio": 0.0,
            "coverage": 0.0,
            "matchedLineCount": 0,
            "matchedLineRatio": 0.0,
            "matches": {},
        }

    global_ratio = SequenceMatcher(None, source_full_norm, utaten_full_norm).ratio()
    if global_ratio < settings["globalRatioThreshold"]:
        return {
            "accepted": False,
            "reason": "global_ratio_below_threshold",
            "globalRatio": global_ratio,
            "coverage": 0.0,
            "matchedLineCount": 0,
            "matchedLineRatio": 0.0,
            "matches": {},
        }

    source_count = len(eligible_source_lines)
    utaten_count = len(utaten_lines)
    dp = [[None for _ in range(utaten_count + 1)] for _ in range(source_count + 1)]
    dp[0][0] = {
        "score": 0.0,
        "matchedChars": 0,
        "matchedLines": 0,
        "prev": None,
        "action": None,
    }

    def is_better_state(candidate, current):
        if current is None:
            return True
        if candidate["score"] != current["score"]:
            return candidate["score"] > current["score"]
        if candidate["matchedChars"] != current["matchedChars"]:
            return candidate["matchedChars"] > current["matchedChars"]
        if candidate["matchedLines"] != current["matchedLines"]:
            return candidate["matchedLines"] > current["matchedLines"]
        return False

    for source_index in range(source_count + 1):
        for utaten_index in range(utaten_count + 1):
            state = dp[source_index][utaten_index]
            if state is None:
                continue
            if source_index < source_count:
                source_line = eligible_source_lines[source_index]
                skip_penalty = -0.45 if source_line.get("requiresRomaji") else 0.0
                skip_source_state = {
                    "score": state["score"] + skip_penalty,
                    "matchedChars": state["matchedChars"],
                    "matchedLines": state["matchedLines"],
                    "prev": (source_index, utaten_index),
                    "action": {"type": "skip_source"},
                }
                if is_better_state(skip_source_state, dp[source_index + 1][utaten_index]):
                    dp[source_index + 1][utaten_index] = skip_source_state
            if utaten_index < utaten_count:
                skip_utaten_state = {
                    "score": state["score"] - 0.1,
                    "matchedChars": state["matchedChars"],
                    "matchedLines": state["matchedLines"],
                    "prev": (source_index, utaten_index),
                    "action": {"type": "skip_utaten"},
                }
                if is_better_state(skip_utaten_state, dp[source_index][utaten_index + 1]):
                    dp[source_index][utaten_index + 1] = skip_utaten_state
            if source_index >= source_count:
                continue
            for source_merge_length in range(1, settings["sourceLineMergeLimit"] + 1):
                next_source_index = source_index + source_merge_length
                if next_source_index > source_count:
                    break
                source_span_lines = eligible_source_lines[source_index:next_source_index]
                source_span = combine_source_line_span(source_span_lines)
                source_norm = source_span.get("norm")
                if not source_norm:
                    continue
                for utaten_merge_length in range(1, settings["lineMergeLimit"] + 1):
                    next_utaten_index = utaten_index + utaten_merge_length
                    if next_utaten_index > utaten_count:
                        break
                    utaten_span = combine_utaten_line_span(utaten_lines[utaten_index:next_utaten_index])
                    similarity = score_utaten_alignment_candidate(source_norm, utaten_span.get("norm"))
                    if similarity < settings["minLineSimilarity"]:
                        continue
                    allocations = None
                    if source_merge_length > 1:
                        allocations = split_utaten_span_for_source_lines(source_span_lines, utaten_span)
                        if allocations is None:
                            continue
                    match_state = {
                        "score": state["score"] + similarity,
                        "matchedChars": state["matchedChars"] + source_span.get("requiredCharCount", 0),
                        "matchedLines": state["matchedLines"] + source_span.get("requiredLineCount", 0),
                        "prev": (source_index, utaten_index),
                        "action": {
                            "type": "match",
                            "sourceStart": source_index,
                            "sourceEnd": next_source_index,
                            "utatenStart": utaten_index,
                            "utatenEnd": next_utaten_index,
                            "similarity": similarity,
                            "allocations": allocations,
                        },
                    }
                    if is_better_state(match_state, dp[next_source_index][next_utaten_index]):
                        dp[next_source_index][next_utaten_index] = match_state

    final_state = dp[source_count][utaten_count]
    if not final_state:
        return {
            "accepted": False,
            "reason": "alignment_dp_failed",
            "globalRatio": global_ratio,
            "coverage": 0.0,
            "matchedLineCount": 0,
            "matchedLineRatio": 0.0,
            "matches": {},
        }

    matches = {}
    blocks = []
    cursor = (source_count, utaten_count)
    while cursor:
        state = dp[cursor[0]][cursor[1]]
        if not state or not state.get("prev"):
            break
        action = state.get("action") or {}
        if action.get("type") == "match":
            block = {
                "sourceStart": action["sourceStart"],
                "sourceEnd": action["sourceEnd"],
                "utatenStart": action["utatenStart"],
                "utatenEnd": action["utatenEnd"],
                "similarity": action["similarity"],
                "allocations": action.get("allocations"),
            }
            blocks.append(block)
            if action["sourceEnd"] - action["sourceStart"] == 1:
                source_line = eligible_source_lines[action["sourceStart"]]
                if source_line.get("requiresRomaji"):
                    matches[source_line["index"]] = {
                        "utatenStart": action["utatenStart"],
                        "utatenEnd": action["utatenEnd"],
                        "similarity": action["similarity"],
                    }
        cursor = state["prev"]
    blocks.reverse()

    total_source_chars = sum(len(line.get("norm") or "") for line in required_source_lines)
    matched_line_count = final_state["matchedLines"]
    coverage = (final_state["matchedChars"] / total_source_chars) if total_source_chars else 0.0
    matched_line_ratio = (matched_line_count / len(required_source_lines)) if required_source_lines else 0.0
    min_required_lines = min(settings["minMatchedLines"], len(required_source_lines))
    if coverage < settings["coverageThreshold"]:
        return {
            "accepted": False,
            "reason": "coverage_below_threshold",
            "globalRatio": global_ratio,
            "coverage": coverage,
            "matchedLineCount": matched_line_count,
            "matchedLineRatio": matched_line_ratio,
            "matches": matches,
        }
    if matched_line_ratio < settings["matchedLineRatioThreshold"]:
        return {
            "accepted": False,
            "reason": "matched_line_ratio_below_threshold",
            "globalRatio": global_ratio,
            "coverage": coverage,
            "matchedLineCount": matched_line_count,
            "matchedLineRatio": matched_line_ratio,
            "matches": matches,
        }
    if matched_line_count < min_required_lines:
        return {
            "accepted": False,
            "reason": "matched_line_count_below_threshold",
            "globalRatio": global_ratio,
            "coverage": coverage,
            "matchedLineCount": matched_line_count,
            "matchedLineRatio": matched_line_ratio,
            "matches": matches,
        }

    return {
        "accepted": True,
        "reason": "applied",
        "globalRatio": global_ratio,
        "coverage": coverage,
        "matchedLineCount": matched_line_count,
        "matchedLineRatio": matched_line_ratio,
        "matches": matches,
        "blocks": blocks,
    }


def project_utaten_word_romanization(source_words, utaten_tokens):
    if not isinstance(source_words, list) or not source_words:
        return None

    normalized_tokens = []
    for token in utaten_tokens or []:
        base = normalize_space(token.get("base"))
        romaji = normalize_space(token.get("romaji")) or base
        norm = normalize_utaten_match_text(base)
        if not norm:
            continue
        normalized_tokens.append({
            "norm": norm,
            "romaji": romaji,
        })

    if not normalized_tokens:
        return None

    projected_words = []
    token_index = 0
    for word in source_words:
        word_text = str((word or {}).get("text") or "")
        word_norm = normalize_utaten_match_text(word_text)
        if not word_norm:
            projected_words.append({
                "text": "\u00A0",
                "start": word.get("start"),
                "end": word.get("end"),
            })
            continue

        romaji_segments = []
        accumulated_norm = ""
        cursor = token_index
        while cursor < len(normalized_tokens):
            accumulated_norm += normalized_tokens[cursor]["norm"]
            romaji_segments.append(normalized_tokens[cursor]["romaji"])
            cursor += 1
            if accumulated_norm == word_norm:
                projected_words.append({
                    "text": smart_join_romaji_segments(romaji_segments),
                    "start": word.get("start"),
                    "end": word.get("end"),
                })
                token_index = cursor
                break
            if not word_norm.startswith(accumulated_norm):
                return None
        else:
            return None

    return projected_words if len(projected_words) == len(source_words) else None


def apply_utaten_romaji_to_result(result, candidate, page, alignment):
    if not isinstance(result, dict):
        return result

    for block in (alignment.get("blocks") or []):
        source_start = block.get("sourceStart")
        source_end = block.get("sourceEnd")
        utaten_start = block.get("utatenStart")
        utaten_end = block.get("utatenEnd")
        if source_start is None or source_end is None or utaten_start is None or utaten_end is None:
            continue
        source_block = []
        for source_index in range(source_start, source_end):
            if source_index < 0 or source_index >= len(result.get("lines") or []):
                continue
            target_line = result["lines"][source_index]
            source_block.append({
                "index": source_index,
                "text": normalize_space(target_line.get("text")),
                "norm": normalize_utaten_match_text(target_line.get("text")),
                "requiresRomaji": source_line_requires_utaten({"text": target_line.get("text")}),
            })
        utaten_span = combine_utaten_line_span(page["lines"][utaten_start:utaten_end])
        allocations = block.get("allocations") or split_utaten_span_for_source_lines(source_block, utaten_span)

        if allocations is None and len(source_block) == 1:
            only_source = source_block[0]
            allocations = {
                only_source["index"]: {
                    "tokens": utaten_span.get("tokens") or [],
                    "base": utaten_span.get("base") or "",
                    "romaji": utaten_span.get("romaji") or "",
                    "norm": utaten_span.get("norm") or "",
                }
            }
        if allocations is None:
            continue

        for source_line in source_block:
            source_index = source_line["index"]
            if not source_line.get("requiresRomaji"):
                continue
            allocation = allocations.get(source_index) or {}
            romaji_text = normalize_space(allocation.get("romaji"))
            if not romaji_text:
                continue
            target_line = result["lines"][source_index]
            word_projection = project_utaten_word_romanization(target_line.get("words"), allocation.get("tokens"))
            utaten_track = {
                "lang": "ja-Latn",
                "source": "utaten",
                "timing": "word" if word_projection else "line",
                "text": romaji_text,
            }
            if word_projection:
                utaten_track["words"] = word_projection
            existing_tracks = [
                track for track in (target_line.get("romanizations") or [])
                if normalize_space(track.get("source")).lower() != "utaten"
            ]
            target_line["romanizations"] = [utaten_track, *existing_tracks]

    metadata = result.setdefault("metadata", {})
    auxiliary_summary = summarize_auxiliary_track_support(result.get("lines"))
    metadata["hasRomanizations"] = auxiliary_summary.get("hasRomanizations")
    metadata["romanizationLanguages"] = auxiliary_summary.get("romanizationLanguages")
    metadata["romanizationSources"] = auxiliary_summary.get("romanizationSources")
    metadata["utatenRomaji"] = {
        "applied": True,
        "reason": "applied",
        "pageUrl": candidate.get("url"),
        "searchMode": candidate.get("searchMode"),
        "coverage": round(alignment.get("coverage") or 0.0, 3),
        "matchedLineCount": int(alignment.get("matchedLineCount") or 0),
        "globalRatio": round(alignment.get("globalRatio") or 0.0, 3),
        "candidateCount": int(alignment.get("candidateCount") or 0),
    }
    return result


def build_utaten_alignment_ranking(alignment, candidate=None):
    candidate = candidate or {}
    return (
        round(alignment.get("coverage") or 0.0, 6),
        int(alignment.get("matchedLineCount") or 0),
        round(alignment.get("matchedLineRatio") or 0.0, 6),
        round(alignment.get("globalRatio") or 0.0, 6),
        -int(candidate.get("searchPriority") or 0),
        -int(candidate.get("searchRank") or 0),
    )


def fetch_utaten_candidate_page(candidate, deadline_at=None):
    if not isinstance(candidate, dict):
        return None
    page = fetch_utaten_romaji_page(candidate.get("url"), deadline_at=deadline_at)
    if not page:
        return None
    return {
        "candidate": candidate,
        "page": page,
    }


def evaluate_utaten_candidate(source_lines, preview_source_lines, candidate_page):
    candidate = (candidate_page or {}).get("candidate") or {}
    page = (candidate_page or {}).get("page") or {}
    page_lines = page.get("lines") or []
    preview_lines = build_utaten_preview_candidate_lines(page_lines, preview_source_lines)
    preview_alignment = align_utaten_lines(
        preview_source_lines,
        preview_lines,
        options=UTATEN_PREVIEW_ALIGNMENT_OPTIONS,
    )
    if not preview_alignment.get("accepted"):
        return {
            "accepted": False,
            "reason": f"preview_{preview_alignment.get('reason') or 'no_valid_candidate'}",
            "candidate": candidate,
            "page": page,
            "alignment": preview_alignment,
            "ranking": build_utaten_alignment_ranking(preview_alignment, candidate),
        }

    alignment = align_utaten_lines(source_lines, page_lines)
    if not alignment.get("accepted"):
        return {
            "accepted": False,
            "reason": alignment.get("reason") or "no_valid_candidate",
            "candidate": candidate,
            "page": page,
            "alignment": alignment,
            "previewAlignment": preview_alignment,
            "ranking": build_utaten_alignment_ranking(alignment, candidate),
        }

    alignment["candidateCount"] = 0
    return {
        "accepted": True,
        "candidate": candidate,
        "page": page,
        "alignment": alignment,
        "previewAlignment": preview_alignment,
        "ranking": build_utaten_alignment_ranking(alignment, candidate),
    }


def find_best_utaten_candidate_match(query, source_lines, deadline_at=None):
    preview_source_lines = build_utaten_preview_source_lines(source_lines)
    search_steps = build_utaten_search_steps(query, source_lines)
    if not preview_source_lines or not search_steps:
        return {
            "candidateCount": 0,
            "bestMatch": None,
            "bestRejection": None,
        }

    executor = ThreadPoolExecutor(max_workers=UTATEN_SEARCH_WORKERS + UTATEN_PAGE_FETCH_WORKERS)
    pending_search_futures = {}
    pending_page_futures = {}
    seen_lyric_ids = set()
    candidate_count = 0
    best_match = None
    best_rejection = None

    try:
        for step in search_steps:
            if is_deadline_exceeded(deadline_at, 1.5):
                break
            future = executor.submit(fetch_utaten_search_step_candidates, step, deadline_at)
            pending_search_futures[future] = step

        while (pending_search_futures or pending_page_futures) and not is_deadline_exceeded(deadline_at, 1.0):
            done, _ = wait(
                [*pending_search_futures.keys(), *pending_page_futures.keys()],
                timeout=0.2,
                return_when=FIRST_COMPLETED,
            )
            if not done:
                continue

            for future in done:
                if future in pending_search_futures:
                    pending_search_futures.pop(future, None)
                    try:
                        candidates = future.result() or []
                    except Exception:
                        candidates = []

                    for candidate in candidates:
                        lyric_id = candidate.get("lyricId") or candidate.get("url")
                        if lyric_id in seen_lyric_ids:
                            continue
                        seen_lyric_ids.add(lyric_id)
                        candidate_count += 1
                        page_future = executor.submit(fetch_utaten_candidate_page, candidate, deadline_at)
                        pending_page_futures[page_future] = candidate
                    continue

                candidate = pending_page_futures.pop(future, None) or {}
                try:
                    candidate_page = future.result()
                except Exception:
                    candidate_page = None

                if not candidate_page:
                    rejection = {
                        "reason": "candidate_page_fetch_failed",
                        "pageUrl": candidate.get("url"),
                        "searchMode": candidate.get("searchMode"),
                        "coverage": 0.0,
                        "matchedLineCount": 0,
                        "globalRatio": 0.0,
                        "ranking": (0.0, 0, 0.0, 0.0, 0, 0),
                    }
                    if best_rejection is None or rejection["ranking"] > best_rejection["ranking"]:
                        best_rejection = rejection
                    continue

                evaluation = evaluate_utaten_candidate(source_lines, preview_source_lines, candidate_page)
                alignment = evaluation.get("alignment") or {}
                candidate_info = evaluation.get("candidate") or candidate
                ranking = evaluation.get("ranking") or (0.0, 0, 0.0, 0.0, 0, 0)

                if not evaluation.get("accepted"):
                    rejection = {
                        "reason": evaluation.get("reason") or "no_valid_candidate",
                        "pageUrl": candidate_info.get("url"),
                        "searchMode": candidate_info.get("searchMode"),
                        "coverage": round(alignment.get("coverage") or 0.0, 3),
                        "matchedLineCount": int(alignment.get("matchedLineCount") or 0),
                        "globalRatio": round(alignment.get("globalRatio") or 0.0, 3),
                        "ranking": ranking,
                    }
                    if best_rejection is None or ranking > best_rejection["ranking"]:
                        best_rejection = rejection
                    continue

                alignment["candidateCount"] = candidate_count
                next_match = {
                    "candidate": candidate_info,
                    "page": evaluation.get("page"),
                    "alignment": alignment,
                    "previewAlignment": evaluation.get("previewAlignment"),
                    "ranking": ranking,
                }
                if best_match is None or ranking > best_match["ranking"]:
                    best_match = next_match
                if (
                    (alignment.get("coverage") or 0.0) >= UTATEN_STRONG_MATCH_COVERAGE
                    and (alignment.get("globalRatio") or 0.0) >= UTATEN_STRONG_MATCH_GLOBAL_RATIO
                    and (alignment.get("matchedLineRatio") or 0.0) >= UTATEN_STRONG_MATCHED_LINE_RATIO
                ):
                    return {
                        "candidateCount": candidate_count,
                        "bestMatch": best_match,
                        "bestRejection": best_rejection,
                    }

        return {
            "candidateCount": candidate_count,
            "bestMatch": best_match,
            "bestRejection": best_rejection,
        }
    finally:
        executor.shutdown(wait=False, cancel_futures=True)


def maybe_apply_utaten_romaji(result, query, payload, attempted_sources, deadline_at=None):
    if not isinstance(result, dict) or result.get("found") is not True:
        return result

    metadata = result.setdefault("metadata", {})
    utaten_metadata = {
        "applied": False,
        "reason": "disabled",
        "pageUrl": None,
        "searchMode": None,
        "coverage": 0.0,
        "matchedLineCount": 0,
        "globalRatio": 0.0,
        "candidateCount": 0,
    }
    metadata["utatenRomaji"] = utaten_metadata

    if not payload.get("utatenRomajiEnabled"):
        return result

    source_lines = [
        {"index": index, "text": normalize_space(line.get("text"))}
        for index, line in enumerate(result.get("lines") or [])
        if normalize_space(line.get("text"))
    ]
    if not is_source_lyrics_eligible_for_utaten(source_lines):
        utaten_metadata["reason"] = "source_not_japanese"
        return result

    if "utaten" not in attempted_sources:
        attempted_sources.append("utaten")

    candidate_lookup = find_best_utaten_candidate_match(query, source_lines, deadline_at=deadline_at)
    utaten_metadata["candidateCount"] = int(candidate_lookup.get("candidateCount") or 0)
    best_match = candidate_lookup.get("bestMatch")
    best_rejection = candidate_lookup.get("bestRejection")

    if utaten_metadata["candidateCount"] <= 0 and not best_match:
        utaten_metadata["reason"] = "lookup_deadline_exceeded" if is_deadline_exceeded(deadline_at, 3.0) else "no_search_candidates"
        result["attemptedSources"] = list(attempted_sources)
        return result

    if not best_match:
        if is_deadline_exceeded(deadline_at, 1.0):
            utaten_metadata["reason"] = "lookup_deadline_exceeded"
            result["attemptedSources"] = list(attempted_sources)
            return result
        if best_rejection:
            utaten_metadata["reason"] = best_rejection.get("reason") or "no_valid_candidate"
            utaten_metadata["pageUrl"] = best_rejection.get("pageUrl")
            utaten_metadata["searchMode"] = best_rejection.get("searchMode")
            utaten_metadata["coverage"] = best_rejection.get("coverage") or 0.0
            utaten_metadata["matchedLineCount"] = best_rejection.get("matchedLineCount") or 0
            utaten_metadata["globalRatio"] = best_rejection.get("globalRatio") or 0.0
        else:
            utaten_metadata["reason"] = "no_valid_candidate"
        result["attemptedSources"] = list(attempted_sources)
        return result

    result["attemptedSources"] = list(attempted_sources)
    return apply_utaten_romaji_to_result(
        result,
        best_match["candidate"],
        best_match["page"],
        best_match["alignment"],
    )


def finalize_lines(lines, fallback_duration=None):
    normalized = []
    for line in lines or []:
        if not line or not line.get("text") or line.get("start") is None:
            continue
        normalized_line = {
            "text": normalize_space(line.get("text")),
            "start": round(float(line["start"]), 3),
            "end": round(float(line["end"]), 3) if line.get("end") is not None else None,
            "words": line.get("words"),
        }
        if line.get("backgroundText"):
            normalized_line["backgroundText"] = normalize_space(line.get("backgroundText"))
        if line.get("backgroundWords"):
            normalized_line["backgroundWords"] = line.get("backgroundWords")
        for key, value in line.items():
            if key in {"text", "start", "end", "words", "backgroundText", "backgroundWords"} or value is None:
                continue
            normalized_line[key] = value
        normalized.append(normalized_line)
    normalized.sort(key=lambda item: item["start"])
    for index, line in enumerate(normalized):
        next_line = normalized[index + 1] if index + 1 < len(normalized) else None
        fallback_end = fallback_duration if fallback_duration is not None else line["start"] + 5
        candidate_end = next_line["start"] if next_line else fallback_end
        if line["end"] is None or line["end"] <= line["start"]:
            line["end"] = round(max(line["start"] + 0.4, candidate_end), 3)
        line["words"] = normalize_word_entries(line.get("words"), line["end"])
        line["backgroundWords"] = normalize_word_entries(line.get("backgroundWords"), line["end"])
    return normalized


def parse_time_tag(value):
    match = re.match(r"^(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?$", str(value or "").strip())
    if not match:
        return None
    minutes = int(match.group(1))
    seconds = int(match.group(2))
    fraction_raw = match.group(3) or "0"
    fraction = int(fraction_raw) / (1000 if len(fraction_raw) == 3 else 100)
    return round((minutes * 60) + seconds + fraction, 3)


def parse_lrc(raw_text, fallback_duration=None):
    lines = []
    has_word_timing = False
    for raw_line in str(raw_text or "").splitlines():
        time_tags = list(re.finditer(r"\[(\d{1,2}:\d{2}(?:[.:]\d{1,3})?)\]", raw_line))
        if not time_tags:
            continue
        text_without_line_tags = re.sub(r"\[(\d{1,2}:\d{2}(?:[.:]\d{1,3})?)\]", "", raw_line)
        word_matches = list(re.finditer(r"<(\d{1,2}:\d{2}(?:[.:]\d{1,3})?)>([^<]+)", text_without_line_tags))
        plain_text = normalize_space(re.sub(r"<(\d{1,2}:\d{2}(?:[.:]\d{1,3})?)>", "", text_without_line_tags))
        inline_words = []
        for match in word_matches:
            start = parse_time_tag(match.group(1))
            token_text = match.group(2)
            if start is None or not token_text:
                continue
            inline_words.append({"text": token_text, "start": start, "end": None})
        if inline_words:
            has_word_timing = True
        for match in time_tags:
            start = parse_time_tag(match.group(1))
            if start is None or not plain_text:
                continue
            lines.append({"text": plain_text, "start": start, "end": None, "words": inline_words or None})
    finalized = finalize_lines(lines, fallback_duration=fallback_duration)
    if not finalized:
        return None
    return {"type": "word" if has_word_timing else "line", "lines": finalized}


def split_artists(artist_text):
    artists = [normalize_space(part) for part in re.split(r"\s*(?:,|&|/|、|，|;| feat\. | ft\. )\s*", str(artist_text or ""), flags=re.I)]
    return [artist for artist in artists if artist]


def needs_leading_space(previous_raw, current_text):
    if not previous_raw:
        return False
    if not current_text or current_text.isspace():
        return False
    previous_text = str(previous_raw.get("text") or "")
    if not previous_text or previous_text.isspace():
        return False
    if previous_raw.get("part"):
        return False
    if current_text[0] in ",.;:!?)]}%":
        return False
    if previous_text[-1] in "([{/'\"-":
        return False
    if is_cjk_like_char(previous_text[-1]) or is_cjk_like_char(current_text[0]):
        return False
    return True


def build_line_from_tokens(raw_tokens, line_start, line_end):
    if isinstance(raw_tokens, str):
        text = normalize_space(raw_tokens)
        if not text:
            return None
        return {"text": text, "start": line_start, "end": line_end, "words": None}

    if not isinstance(raw_tokens, list):
        return None

    words = []
    previous_raw = None
    pending_prefix = ""
    for raw_token in raw_tokens:
        if not isinstance(raw_token, dict):
            continue
        token_text = str(raw_token.get("text") or "")
        if not token_text:
            previous_raw = raw_token
            continue
        if token_text.isspace():
            pending_prefix += token_text
            previous_raw = raw_token
            continue
        if pending_prefix:
            token_text = f"{pending_prefix}{token_text}"
            pending_prefix = ""
        if needs_leading_space(previous_raw, token_text):
            token_text = f" {token_text}"
        word_start = to_seconds(raw_token.get("timestamp"))
        word_end = to_seconds(raw_token.get("endtime"))
        if word_start is None:
            previous_raw = raw_token
            continue
        words.append({"text": token_text, "start": word_start, "end": word_end})
        previous_raw = raw_token

    line_text = "".join(word["text"] for word in words).strip()
    if not line_text:
        return None
    return {
        "text": line_text,
        "start": line_start,
        "end": line_end,
        "words": words or None,
    }


def parse_paxsenix_timed_content(content):
    lines = []
    if not isinstance(content, list):
        return lines
    for item in content:
        if not isinstance(item, dict):
            continue
        line_start = to_seconds(item.get("timestamp"))
        line_end = to_seconds(item.get("endtime"))
        if line_start is None:
            continue
        line = build_line_from_tokens(item.get("text"), line_start, line_end)
        if line:
            lines.append(line)
    return lines


def parse_ttml_agents(root):
    agents = []
    for element in root.iter():
        if local_name(getattr(element, "tag", "")) != "agent":
            continue
        agent_id = get_xml_attr(element, "id")
        if not agent_id:
            continue
        name = ""
        for child in list(element):
            if local_name(getattr(child, "tag", "")) == "name":
                name = normalize_space("".join(child.itertext()))
                if name:
                    break
        agents.append({
            "id": agent_id,
            "type": normalize_space(get_xml_attr(element, "type")) or "other",
            "name": name or None,
        })
    return agents


def parse_ttml_songwriters(root):
    songwriters = []
    for element in root.iter():
        if local_name(getattr(element, "tag", "")) != "songwriter":
            continue
        value = normalize_space("".join(element.itertext()))
        if value:
            songwriters.append(value)
    return songwriters


def strip_auxiliary_track_role(track):
    return {key: value for key, value in (track or {}).items() if key != "role"}


def build_ttml_head_auxiliary_track(text_element, track_type, lang=None, source="itunes_metadata", track_subtype=None):
    buckets = collect_ttml_track_events(
        text_element,
        track_type=track_type,
        lang=lang,
        background=False,
        source=source,
        track_subtype=track_subtype,
        agent_id=None,
        buckets={},
    )
    tracks = build_auxiliary_track_entries(buckets)
    for track in tracks:
        if track.get("role") == track_type:
            return track
    return None


def parse_ttml_head_auxiliary_tracks(root):
    tracks_by_line_key = {}
    metadata = {}

    for element in root.iter():
        if normalize_xml_name(getattr(element, "tag", "")) != "itunesmetadata":
            continue

        leading_silence_raw = normalize_space(get_xml_attr(element, "leadingSilence"))
        if leading_silence_raw and "leadingSilenceRaw" not in metadata:
            metadata["leadingSilenceRaw"] = leading_silence_raw
            parsed_leading_silence = parse_clock_time(leading_silence_raw)
            if parsed_leading_silence is not None:
                metadata["leadingSilence"] = parsed_leading_silence

        for container in list(element):
            container_name = normalize_xml_name(getattr(container, "tag", ""))
            if container_name not in {"translations", "transliterations"}:
                continue
            track_type = "translation" if container_name == "translations" else "roman"
            expected_child_name = "translation" if track_type == "translation" else "transliteration"

            for language_block in list(container):
                if normalize_xml_name(getattr(language_block, "tag", "")) != expected_child_name:
                    continue

                lang = normalize_space(get_xml_attr(language_block, "lang")) or None
                track_subtype = normalize_space(get_xml_attr(language_block, "type")) or None

                for text_element in list(language_block):
                    if normalize_xml_name(getattr(text_element, "tag", "")) != "text":
                        continue
                    line_key = normalize_space(get_xml_attr(text_element, "for"))
                    if not line_key:
                        continue
                    track = build_ttml_head_auxiliary_track(
                        text_element,
                        track_type=track_type,
                        lang=lang,
                        source="itunes_metadata",
                        track_subtype=track_subtype,
                    )
                    if not track:
                        continue
                    tracks_by_line_key.setdefault(line_key, []).append(track)

    return tracks_by_line_key, metadata


def summarize_auxiliary_track_support(lines):
    summary = {
        "hasTranslations": False,
        "hasRomanizations": False,
        "translationLanguages": [],
        "romanizationLanguages": [],
        "translationSources": [],
        "romanizationSources": [],
        "translationTypes": [],
        "hasBackgroundVocals": False,
        "hasDuet": False,
    }

    for line in lines or []:
        if line.get("backgroundText") or line.get("backgroundWords"):
            summary["hasBackgroundVocals"] = True
        if line.get("oppositeTurn"):
            summary["hasDuet"] = True

        for translation in line.get("translations") or []:
            summary["hasTranslations"] = True
            lang = normalize_space(translation.get("lang"))
            source = normalize_space(translation.get("source"))
            track_type = normalize_space(translation.get("type"))
            if lang and lang not in summary["translationLanguages"]:
                summary["translationLanguages"].append(lang)
            if source and source not in summary["translationSources"]:
                summary["translationSources"].append(source)
            if track_type and track_type not in summary["translationTypes"]:
                summary["translationTypes"].append(track_type)

        for romanization in line.get("romanizations") or []:
            summary["hasRomanizations"] = True
            lang = normalize_space(romanization.get("lang"))
            source = normalize_space(romanization.get("source"))
            if lang and lang not in summary["romanizationLanguages"]:
                summary["romanizationLanguages"].append(lang)
            if source and source not in summary["romanizationSources"]:
                summary["romanizationSources"].append(source)

    return summary


def build_line_from_ttml_paragraph(paragraph, section=None, head_auxiliary_tracks=None):
    line_start = parse_clock_time(get_xml_attr(paragraph, "begin"))
    line_end = parse_clock_time(get_xml_attr(paragraph, "end"))
    line_agent = normalize_space(get_xml_attr(paragraph, "agent")) or None
    line_key = normalize_space(get_xml_attr(paragraph, "key")) or None
    line_lang = normalize_space(get_xml_attr(paragraph, "lang")) or None

    buckets = collect_ttml_track_events(
        paragraph,
        track_type="main",
        lang=line_lang,
        background=False,
        source="inline",
        track_subtype=None,
        agent_id=line_agent,
        buckets={},
    )
    main_content = build_track_content_from_bucket_events(
        buckets.get(make_ttml_bucket_key("main", line_lang, False, "inline", None)),
        fallback_start=line_start,
        fallback_end=line_end,
    )
    background_content = build_track_content_from_bucket_events(
        buckets.get(make_ttml_bucket_key("main", line_lang, True, "inline", None)),
        fallback_start=line_start,
        fallback_end=line_end,
    )
    if not main_content or not main_content.get("text"):
        return None

    if line_start is None:
        line_start = main_content.get("start")
    if line_end is None:
        line_end = main_content.get("end")
    if line_start is None:
        return None

    line = {
        "text": main_content.get("text"),
        "start": line_start,
        "end": line_end,
        "words": main_content.get("words"),
    }
    if section:
        line["section"] = section
    if line_key:
        line["key"] = line_key
    if line_lang:
        line["lang"] = line_lang
    effective_agent = extract_line_agent(main_content.get("words"), default_agent=line_agent)
    if effective_agent:
        line["agent"] = effective_agent
    if background_content and background_content.get("text"):
        line["backgroundText"] = background_content.get("text")
    if background_content and background_content.get("words"):
        line["backgroundWords"] = background_content.get("words")

    inline_auxiliary_tracks = build_auxiliary_track_entries(buckets, fallback_start=line_start, fallback_end=line_end)
    combined_auxiliary_tracks = list(head_auxiliary_tracks.get(line_key) or []) if line_key and isinstance(head_auxiliary_tracks, dict) else []
    combined_auxiliary_tracks.extend(inline_auxiliary_tracks)

    translations = [strip_auxiliary_track_role(track) for track in combined_auxiliary_tracks if track.get("role") == "translation"]
    romanizations = [strip_auxiliary_track_role(track) for track in combined_auxiliary_tracks if track.get("role") == "roman"]
    if translations:
        line["translations"] = translations
    if romanizations:
        line["romanizations"] = romanizations
    return line


def annotate_agent_layout(lines, agents):
    agent_map = {agent.get("id"): agent for agent in agents or [] if agent.get("id")}
    ordered_agents = []
    for line in lines or []:
        agent_id = normalize_space(line.get("agent"))
        if agent_id and agent_id not in ordered_agents:
            ordered_agents.append(agent_id)

    if len(ordered_agents) < 2:
        for line in lines or []:
            agent_id = normalize_space(line.get("agent"))
            if not agent_id:
                continue
            agent = agent_map.get(agent_id) or {}
            if agent.get("name"):
                line["agentName"] = agent.get("name")
            if agent.get("type"):
                line["agentType"] = agent.get("type")
        return

    for index, agent_id in enumerate(ordered_agents):
        agent = agent_map.get(agent_id) or {}
        opposite_turn = (index % 2) == 1
        for line in lines or []:
            if normalize_space(line.get("agent")) != agent_id:
                continue
            line["oppositeTurn"] = opposite_turn
            if agent.get("name"):
                line["agentName"] = agent.get("name")
            if agent.get("type"):
                line["agentType"] = agent.get("type")


def build_background_from_paxsenix_tokens(raw_tokens, line_start, line_end):
    parsed_line = build_line_from_tokens(raw_tokens, line_start, line_end)
    if not parsed_line or not parsed_line.get("text"):
        return None
    return {
        "text": parsed_line.get("text"),
        "words": parsed_line.get("words"),
    }


def enrich_lines_from_paxsenix_content(lines, content):
    if not isinstance(content, list) or not lines:
        return lines

    content_by_start = {}
    for item in content:
        if not isinstance(item, dict):
            continue
        start = to_seconds(item.get("timestamp"))
        if start is None:
            continue
        content_by_start[round(start, 3)] = item

    for line in lines:
        match = content_by_start.get(round(float(line.get("start") or 0), 3))
        if not isinstance(match, dict):
            continue
        structure = normalize_space(match.get("structure"))
        if structure and not line.get("section"):
            line["section"] = structure
        if isinstance(match.get("oppositeTurn"), bool):
            line["oppositeTurn"] = match.get("oppositeTurn")
        if (not line.get("backgroundText")) and match.get("backgroundText"):
            background = build_background_from_paxsenix_tokens(match.get("backgroundText"), line.get("start"), line.get("end"))
            if background:
                line["backgroundText"] = background.get("text")
                if background.get("words"):
                    line["backgroundWords"] = background.get("words")
    return lines


def parse_apple_music_ttml(ttml_content, fallback_duration=None):
    raw_ttml = str(ttml_content or "").strip()
    if not raw_ttml:
        return None
    try:
        root = ET.fromstring(raw_ttml)
    except Exception:
        return None

    body = None
    for element in root.iter():
        if local_name(getattr(element, "tag", "")) == "body":
            body = element
            break
    if body is None:
        return None

    head_auxiliary_tracks, head_auxiliary_metadata = parse_ttml_head_auxiliary_tracks(root)
    lines = []
    for child in list(body):
        child_name = local_name(getattr(child, "tag", ""))
        if child_name == "p":
            line = build_line_from_ttml_paragraph(child, section=None, head_auxiliary_tracks=head_auxiliary_tracks)
            if line:
                lines.append(line)
            continue
        if child_name != "div":
            continue
        section = normalize_space(get_xml_attr(child, "songPart", "song-part")) or None
        for paragraph in list(child):
            if local_name(getattr(paragraph, "tag", "")) != "p":
                continue
            line = build_line_from_ttml_paragraph(paragraph, section=section, head_auxiliary_tracks=head_auxiliary_tracks)
            if line:
                lines.append(line)

    finalized = finalize_lines(lines, fallback_duration=fallback_duration)
    if not finalized:
        return None

    agents = parse_ttml_agents(root)
    annotate_agent_layout(finalized, agents)
    auxiliary_summary = summarize_auxiliary_track_support(finalized)

    return {
        "type": "word" if has_word_level(finalized) else "line",
        "lines": finalized,
        "metadata": {
            "sourceFormat": "ttml",
            "timing": normalize_space(get_xml_attr(root, "timing")) or None,
            "duration": parse_clock_time(get_xml_attr(body, "dur")),
            "xmlLang": normalize_space(get_xml_attr(root, "lang")) or None,
            "agents": agents,
            "songwriters": parse_ttml_songwriters(root),
            "leadingSilence": head_auxiliary_metadata.get("leadingSilence"),
            "leadingSilenceRaw": head_auxiliary_metadata.get("leadingSilenceRaw"),
            "hasTranslations": auxiliary_summary.get("hasTranslations"),
            "hasRomanizations": auxiliary_summary.get("hasRomanizations"),
            "translationLanguages": auxiliary_summary.get("translationLanguages"),
            "romanizationLanguages": auxiliary_summary.get("romanizationLanguages"),
            "translationSources": auxiliary_summary.get("translationSources"),
            "romanizationSources": auxiliary_summary.get("romanizationSources"),
            "translationTypes": auxiliary_summary.get("translationTypes"),
            "hasBackgroundVocals": auxiliary_summary.get("hasBackgroundVocals"),
            "hasDuet": auxiliary_summary.get("hasDuet"),
        },
    }


def parse_apple_music_payload(lyrics_data, fallback_duration=None):
    if not isinstance(lyrics_data, dict):
        return None

    parsed_ttml = parse_apple_music_ttml(lyrics_data.get("ttmlContent"), fallback_duration=fallback_duration)
    if parsed_ttml and parsed_ttml.get("lines"):
        parsed_ttml["lines"] = enrich_lines_from_paxsenix_content(parsed_ttml.get("lines"), lyrics_data.get("content"))
        return parsed_ttml

    for field_name in ("elrc", "lrc"):
        parsed = parse_lrc(lyrics_data.get(field_name), fallback_duration=fallback_duration)
        if parsed and parsed.get("lines"):
            parsed["lines"] = enrich_lines_from_paxsenix_content(parsed.get("lines"), lyrics_data.get("content"))
            parsed["metadata"] = {
                "sourceFormat": field_name,
                "timing": None,
                "duration": fallback_duration,
                "agents": [],
                "songwriters": [],
            }
            return parsed

    lines = parse_paxsenix_timed_content(lyrics_data.get("content"))
    if not lines:
        return None

    lines = enrich_lines_from_paxsenix_content(lines, lyrics_data.get("content"))
    return {
        "type": "word" if has_word_level(lines) else "line",
        "lines": lines,
        "metadata": {
            "sourceFormat": "content",
            "timing": None,
            "duration": fallback_duration,
            "agents": [],
            "songwriters": [],
        },
    }





def has_word_level(lines):
    return any(line.get("words") for line in lines or [])


def is_usable_lines(lines):
    return len(lines or []) >= 2


def strip_line_words(lines):
    stripped = []
    for line in lines or []:
        next_line = {
            "text": line.get("text"),
            "start": line.get("start"),
            "end": line.get("end"),
            "words": None,
        }
        if line.get("backgroundText"):
            next_line["backgroundText"] = line.get("backgroundText")
            next_line["backgroundWords"] = None
        for key, value in line.items():
            if key in {"text", "start", "end", "words", "backgroundText", "backgroundWords"} or value is None:
                continue
            next_line[key] = value
        stripped.append(next_line)
    return stripped


def build_result(source, provider, lines, attempted_sources, metadata=None, plain_lyrics=None, result_type=None):
    final_lines = finalize_lines(lines)
    if not is_usable_lines(final_lines):
        return None
    inferred_type = result_type or ("word" if has_word_level(final_lines) else "line")
    if inferred_type not in ("word", "line"):
        return None
    return {
        "ok": True,
        "found": True,
        "source": source,
        "provider": provider,
        "type": inferred_type,
        "attemptedSources": list(attempted_sources),
        "metadata": metadata or {},
        "plainLyrics": plain_lyrics or "\n".join(line["text"] for line in final_lines),
        "lines": final_lines,
    }


def build_missing_result(query, attempted_sources):
    return {
        "ok": True,
        "found": False,
        "source": None,
        "provider": None,
        "type": None,
        "attemptedSources": list(attempted_sources),
        "metadata": {
            "track": query.get("track"),
            "artist": query.get("artist"),
            "album": query.get("album"),
        },
        "plainLyrics": "",
        "lines": [],
    }


def score_ytmusic_result(result, query):
    title = result.get("title") or result.get("track") or ""
    artists = " ".join(artist.get("name", "") for artist in result.get("artists", []) if isinstance(artist, dict))
    duration = parse_duration_seconds(result.get("duration_seconds"))
    return score_candidate(title, artists, "", duration, query)


def find_ytmusic_video_id(client, payload, query):
    source_id = normalize_space(payload.get("sourceId"))
    if source_id:
        return source_id
    search_query = build_search_query(query)
    if not search_query:
        return None
    try:
        results = client.search(search_query, filter="songs", limit=5) or []
    except Exception:
        return None
    ranked = sorted(results, key=lambda item: score_ytmusic_result(item, query), reverse=True)
    if not ranked:
        return None
    if score_ytmusic_result(ranked[0], query) < 45:
        return None
    return ranked[0].get("videoId")


def fetch_ytmusic(payload, query, attempted_sources):
    attempted_sources.append("ytmusic")
    if YTMusic is None:
        return None
    client = YTMusic()
    video_id = find_ytmusic_video_id(client, payload, query)
    if not video_id:
        return None
    try:
        playlist = client.get_watch_playlist(videoId=video_id)
        browse_id = playlist.get("lyrics")
        if not browse_id:
            return None
        lyrics = client.get_lyrics(browse_id, timestamps=True)
    except Exception:
        return None
    if not lyrics or not lyrics.get("hasTimestamps"):
        return None
    lines = []
    for entry in lyrics.get("lyrics", []) or []:
        text = normalize_space(getattr(entry, "text", ""))
        start_ms = getattr(entry, "start_time", None)
        end_ms = getattr(entry, "end_time", None)
        if not text or start_ms is None:
            continue
        lines.append(
            {
                "text": text,
                "start": round(float(start_ms) / 1000.0, 3),
                "end": round(float(end_ms) / 1000.0, 3) if end_ms is not None else None,
                "words": None,
            }
        )
    lines = clean_lines(lines, query)
    return build_result(
        source="YouTube Music",
        provider="ytmusic",
        lines=lines,
        attempted_sources=attempted_sources,
        metadata={
            "track": query.get("track"),
            "artist": query.get("artist"),
            "album": query.get("album"),
            "videoId": video_id,
            "browseId": browse_id,
        },
        result_type="line",
    )


def fetch_apple_music(query, attempted_sources, deadline_at=None):
    attempted_sources.append("apple_music")
    search_query = build_search_query(query)
    if not search_query:
        return None
    try:
        results = request_json(APPLE_SEARCH_API, params={"q": search_query}, timeout=10.0, retries=1, deadline_at=deadline_at)
    except Exception:
        return None
    if not isinstance(results, list) or not results:
        return None

    ranked = []
    for item in results:
        if not isinstance(item, dict) or not item.get("id"):
            continue
        score = score_candidate(
            item.get("songName"),
            item.get("artistName"),
            item.get("albumName"),
            parse_duration_seconds(item.get("duration"), milliseconds=True),
            query,
        )
        ranked.append((score, item))
    ranked.sort(key=lambda pair: pair[0], reverse=True)

    for _, item in ranked[:5]:
        try:
            lyrics_data = request_json(APPLE_LYRICS_API, params={"id": item["id"]}, timeout=10.0, retries=1, deadline_at=deadline_at)
        except Exception:
            continue
        parsed = parse_apple_music_payload(lyrics_data, fallback_duration=query.get("duration"))
        if not parsed:
            continue
        lines = clean_lines(parsed.get("lines"), query, preserve_symbol_only=True)
        apple_type = str(lyrics_data.get("type", "")).strip().lower()
        if apple_type and apple_type not in WORDLIKE_TYPES:
            lines = strip_line_words(lines)
        result_type = "word" if apple_type in WORDLIKE_TYPES else ("line" if apple_type else parsed.get("type") or ("word" if has_word_level(lines) else "line"))
        parsed_metadata = parsed.get("metadata") if isinstance(parsed.get("metadata"), dict) else {}
        lyrics_metadata = lyrics_data.get("metadata") if isinstance(lyrics_data.get("metadata"), dict) else {}
        track_metadata = lyrics_data.get("track") if isinstance(lyrics_data.get("track"), dict) else {}
        result = build_result(
            source="Apple Music",
            provider="apple_music",
            lines=lines,
            attempted_sources=attempted_sources,
            metadata={
                "track": item.get("songName") or query.get("track"),
                "artist": item.get("artistName") or query.get("artist"),
                "album": item.get("albumName") or query.get("album"),
                "appleMusicId": str(item.get("id")),
                "url": item.get("url"),
                "sourceFormat": parsed_metadata.get("sourceFormat"),
                "timing": parsed_metadata.get("timing"),
                "lyricsDuration": parsed_metadata.get("duration"),
                "xmlLang": parsed_metadata.get("xmlLang"),
                "leadingSilence": parsed_metadata.get("leadingSilence"),
                "leadingSilenceRaw": parsed_metadata.get("leadingSilenceRaw"),
                "agents": parsed_metadata.get("agents") or [],
                "songwriters": parsed_metadata.get("songwriters") or lyrics_metadata.get("songwriters") or [],
                "hasTranslations": bool(parsed_metadata.get("hasTranslations")),
                "hasRomanizations": bool(parsed_metadata.get("hasRomanizations")),
                "translationLanguages": parsed_metadata.get("translationLanguages") or [],
                "romanizationLanguages": parsed_metadata.get("romanizationLanguages") or [],
                "translationSources": parsed_metadata.get("translationSources") or [],
                "romanizationSources": parsed_metadata.get("romanizationSources") or [],
                "translationTypes": parsed_metadata.get("translationTypes") or [],
                "hasBackgroundVocals": bool(parsed_metadata.get("hasBackgroundVocals")),
                "hasDuet": bool(parsed_metadata.get("hasDuet")),
                "appleTrack": {
                    "audioLocale": track_metadata.get("audioLocale"),
                    "composerName": track_metadata.get("composerName"),
                    "discNumber": track_metadata.get("discNumber"),
                    "trackNumber": track_metadata.get("trackNumber"),
                    "genreNames": track_metadata.get("genreNames") or [],
                    "isrc": track_metadata.get("isrc") or item.get("isrc"),
                    "releaseDate": track_metadata.get("releaseDate") or item.get("releaseDate"),
                    "hasTimeSyncedLyrics": track_metadata.get("hasTimeSyncedLyrics"),
                    "isVocalAttenuationAllowed": track_metadata.get("isVocalAttenuationAllowed"),
                    "isAppleDigitalMaster": track_metadata.get("isAppleDigitalMaster"),
                    "isMasteredForItunes": track_metadata.get("isMasteredForItunes"),
                },
            },
            result_type=result_type,
        )
        if result:
            return result
    return None


def fetch_qq_music(query, attempted_sources, deadline_at=None):
    attempted_sources.append("qq_music")
    if not query.get("track") or not query.get("artist") or not query.get("duration"):
        return None
    payload = {
        "title": query.get("track"),
        "artist": split_artists(query.get("artist")),
        "album": query.get("album") or "",
        "duration": int(query.get("duration")),
    }
    try:
        response = request_json(QQ_LYRICS_API, method="POST", data=payload, timeout=10.0, retries=1, deadline_at=deadline_at)
    except Exception:
        return None
    lines = clean_lines(parse_paxsenix_timed_content(response.get("lyrics")), query)
    return build_result(
        source="QQ Music",
        provider="qq_music",
        lines=lines,
        attempted_sources=attempted_sources,
        metadata={
            "track": query.get("track"),
            "artist": query.get("artist"),
            "album": query.get("album"),
            "songID": ((response.get("raw_data") or {}).get("songID")),
        },
        result_type="word" if has_word_level(lines) else "line",
    )








def run_provider(provider_key, payload, query, attempted_sources, deadline_at=None):
    if provider_key == "ytmusic":
        return fetch_ytmusic(payload, query, attempted_sources)
    if provider_key == "apple_music":
        return fetch_apple_music(query, attempted_sources, deadline_at=deadline_at)
    if provider_key == "qq_music":
        return fetch_qq_music(query, attempted_sources, deadline_at=deadline_at)
    return None


def normalize_source_key(value):
    source = normalize_space(value).lower()
    return source if source in {"auto", *PROVIDER_ORDER} else "auto"



def execute_lookup(payload):
    query = {
        "track": strip_decorators(payload.get("track")),
        "artist": normalize_space(payload.get("artist")),
        "album": normalize_space(payload.get("album")),
        "duration": parse_duration_seconds(payload.get("duration")),
    }
    preferred_source = normalize_source_key(payload.get("preferredSource"))
    attempted_sources = []
    lookup_deadline_seconds = LOOKUP_DEADLINE_WITH_UTATEN_SECONDS if payload.get("utatenRomajiEnabled") else LOOKUP_DEADLINE_SECONDS
    deadline_at = time.monotonic() + lookup_deadline_seconds

    if preferred_source == "auto":
        cached_line_results = {}

        # Phase 1: Apple Music (word-level preferred)
        if not is_deadline_exceeded(deadline_at, 5.0):
            result = run_provider("apple_music", payload, query, attempted_sources, deadline_at=deadline_at)
            if result:
                if result.get("type") == "word":
                    result["attemptedSources"] = list(attempted_sources)
                    return maybe_apply_utaten_romaji(result, query, payload, attempted_sources, deadline_at=deadline_at)
                if result.get("type") == "line":
                    cached_line_results["apple_music"] = result

        # Phase 2: QQ Music (word-level preferred)
        if not is_deadline_exceeded(deadline_at, 5.0):
            result = run_provider("qq_music", payload, query, attempted_sources, deadline_at=deadline_at)
            if result:
                if result.get("type") == "word":
                    result["attemptedSources"] = list(attempted_sources)
                    return maybe_apply_utaten_romaji(result, query, payload, attempted_sources, deadline_at=deadline_at)
                if result.get("type") == "line":
                    cached_line_results["qq_music"] = result

        # Phase 3: YouTube Music (line-level only)
        if not is_deadline_exceeded(deadline_at, 5.0):
            result = run_provider("ytmusic", payload, query, attempted_sources)
            if result and result.get("type") == "line":
                result["attemptedSources"] = list(attempted_sources)
                return maybe_apply_utaten_romaji(result, query, payload, attempted_sources, deadline_at=deadline_at)

        # Phase 4: Fall back to cached line results (Apple Music first, then QQ)
        for fallback_key in ("apple_music", "qq_music"):
            if fallback_key in cached_line_results:
                line_result = cached_line_results[fallback_key]
                line_result["attemptedSources"] = list(attempted_sources)
                return maybe_apply_utaten_romaji(line_result, query, payload, attempted_sources, deadline_at=deadline_at)

        return build_missing_result(query, attempted_sources)

    result = run_provider(preferred_source, payload, query, attempted_sources, deadline_at=deadline_at)
    if result:
        result["attemptedSources"] = list(attempted_sources)
        return maybe_apply_utaten_romaji(result, query, payload, attempted_sources, deadline_at=deadline_at)
    return build_missing_result(query, attempted_sources)


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except Exception as error:
        print(json.dumps({"ok": False, "error": f"invalid_json:{error}"}, ensure_ascii=True))
        return

    try:
        result = execute_lookup(payload)
    except Exception as error:
        print(json.dumps({"ok": False, "error": f"lookup_failed:{error}"}, ensure_ascii=True))
        return

    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    main()
