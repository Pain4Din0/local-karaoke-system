import gzip
import json
import os
import re
import sys
import time
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
LRCLIB_SEARCH_API = "https://lrclib.net/api/search"
MUSIXMATCH_API = "https://api.paxsenix.org/musixmatch/tracks/match/lyrics"

PROVIDER_ORDER = ["ytmusic", "apple_music", "qq_music", "musixmatch", "lrclib"]
WORDLIKE_TYPES = {"word", "syllable", "character", "verbatim"}
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


def request_json(url, params=None, method="GET", data=None, headers=None, timeout=10.0, retries=2):
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
        request = Request(final_url, data=body, headers=request_headers, method=method.upper())
        try:
            with urlopen(request, timeout=timeout) as response:
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


def clean_lines(lines, query):
    cleaned = []
    dropped_intro = 0
    for line in lines:
        text = normalize_space(line.get("text"))
        if not text:
            continue
        if re.fullmatch(r"[♪♩♫♬♭♯・·•\s]+", text):
            continue
        next_line = {
            "text": text,
            "start": line.get("start"),
            "end": line.get("end"),
            "words": line.get("words"),
        }
        if is_credit_like_text(text, query, next_line["start"]) and not cleaned and dropped_intro < 4:
            dropped_intro += 1
            continue
        cleaned.append(next_line)
    return cleaned


def finalize_lines(lines, fallback_duration=None):
    normalized = [
        {
            "text": normalize_space(line.get("text")),
            "start": round(float(line["start"]), 3),
            "end": round(float(line["end"]), 3) if line.get("end") is not None else None,
            "words": line.get("words"),
        }
        for line in lines
        if line and line.get("text") and line.get("start") is not None
    ]
    normalized.sort(key=lambda item: item["start"])
    for index, line in enumerate(normalized):
        next_line = normalized[index + 1] if index + 1 < len(normalized) else None
        fallback_end = fallback_duration if fallback_duration is not None else line["start"] + 5
        candidate_end = next_line["start"] if next_line else fallback_end
        if line["end"] is None or line["end"] <= line["start"]:
            line["end"] = round(max(line["start"] + 0.4, candidate_end), 3)
        if line.get("words"):
            words = []
            for word in line["words"]:
                start = word.get("start")
                if start is None or word.get("text") is None:
                    continue
                end = word.get("end")
                if end is None or end <= start:
                    end = line["end"]
                words.append(
                    {
                        "text": str(word.get("text")),
                        "start": round(float(start), 3),
                        "end": round(float(end), 3),
                    }
                )
            words.sort(key=lambda item: item["start"])
            line["words"] = words or None
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


def parse_musixmatch_lines(content):
    lines = []
    if not isinstance(content, list):
        return lines
    for item in content:
        if not isinstance(item, dict):
            continue
        text = normalize_space(item.get("text"))
        start = None
        time_data = item.get("time")
        if isinstance(time_data, dict):
            try:
                start = round(float(time_data.get("total")) / 1000.0, 3)
            except Exception:
                start = None
        if text and start is not None:
            lines.append({"text": text, "start": start, "end": None, "words": None})
    return lines


def has_word_level(lines):
    return any(line.get("words") for line in lines or [])


def is_usable_lines(lines):
    return len(lines or []) >= 2


def strip_line_words(lines):
    return [
        {
            "text": line.get("text"),
            "start": line.get("start"),
            "end": line.get("end"),
            "words": None,
        }
        for line in (lines or [])
    ]


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


def fetch_apple_music(query, attempted_sources):
    attempted_sources.append("apple_music")
    search_query = build_search_query(query)
    if not search_query:
        return None
    try:
        results = request_json(APPLE_SEARCH_API, params={"q": search_query}, timeout=10.0, retries=1)
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
            lyrics_data = request_json(APPLE_LYRICS_API, params={"id": item["id"]}, timeout=10.0, retries=1)
        except Exception:
            continue
        lines = clean_lines(parse_paxsenix_timed_content(lyrics_data.get("content")), query)
        apple_type = str(lyrics_data.get("type", "")).strip().lower()
        if apple_type and apple_type not in WORDLIKE_TYPES:
            lines = strip_line_words(lines)
        result_type = "word" if apple_type in WORDLIKE_TYPES else ("line" if apple_type else ("word" if has_word_level(lines) else "line"))
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
            },
            result_type=result_type,
        )
        if result:
            return result
    return None


def fetch_qq_music(query, attempted_sources):
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
        response = request_json(QQ_LYRICS_API, method="POST", data=payload, timeout=10.0, retries=1)
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


def fetch_lrclib(query, attempted_sources):
    attempted_sources.append("lrclib")
    params = {}
    if query.get("track"):
        params["track_name"] = query["track"]
    if query.get("artist"):
        params["artist_name"] = query["artist"]
    if query.get("album"):
        params["album_name"] = query["album"]
    if not params:
        return None
    try:
        results = request_json(LRCLIB_SEARCH_API, params=params, timeout=10.0, retries=1)
    except Exception:
        return None
    if not isinstance(results, list) or not results:
        return None

    ranked = []
    for item in results:
        if not isinstance(item, dict):
            continue
        score = score_candidate(
            item.get("trackName") or item.get("track_name"),
            item.get("artistName") or item.get("artist_name"),
            item.get("albumName") or item.get("album_name"),
            parse_duration_seconds(item.get("duration")),
            query,
        )
        if item.get("syncedLyrics") or item.get("synced_lyrics"):
            score += 20
        ranked.append((score, item))
    ranked.sort(key=lambda pair: pair[0], reverse=True)
    best = ranked[0][1] if ranked else None
    if not best:
        return None

    synced_lyrics = best.get("syncedLyrics") or best.get("synced_lyrics") or ""
    if not synced_lyrics:
        return None
    parsed = parse_lrc(synced_lyrics, fallback_duration=query.get("duration"))
    if not parsed:
        return None
    lines = clean_lines(parsed["lines"], query)
    return build_result(
        source="LRCLIB",
        provider="lrclib",
        lines=lines,
        attempted_sources=attempted_sources,
        metadata={
            "track": best.get("trackName") or best.get("track_name") or query.get("track"),
            "artist": best.get("artistName") or best.get("artist_name") or query.get("artist"),
            "album": best.get("albumName") or best.get("album_name") or query.get("album"),
        },
        plain_lyrics=best.get("plainLyrics") or best.get("plain_lyrics") or None,
        result_type=parsed["type"],
    )


def fetch_musixmatch(query, attempted_sources):
    attempted_sources.append("musixmatch")
    params = {
        "artist": query.get("artist") or "",
        "title": query.get("track") or "",
        "album": query.get("album") or "",
        "duration": query.get("duration") or "",
    }
    if not params["artist"] or not params["title"]:
        return None

    headers = {}
    if PAXSENIX_API_TOKEN:
        headers["Authorization"] = f"Bearer {PAXSENIX_API_TOKEN}"

    try:
        response = request_json(MUSIXMATCH_API, params=params, headers=headers, timeout=10.0, retries=1)
    except Exception:
        return None

    track = response.get("track") if isinstance(response, dict) else None
    if not isinstance(track, dict) or not track.get("has_lyrics"):
        return None

    if track.get("has_richsync") and isinstance(response.get("richsync"), list):
        lines = clean_lines(parse_paxsenix_timed_content(response.get("richsync")), query)
        result = build_result(
            source="Musixmatch",
            provider="musixmatch",
            lines=lines,
            attempted_sources=attempted_sources,
            metadata={
                "track": track.get("track_name") or query.get("track"),
                "artist": track.get("artist_name") or query.get("artist"),
                "album": track.get("album_name") or query.get("album"),
            },
            result_type="word",
        )
        if result:
            return result

    lines = clean_lines(parse_musixmatch_lines(response.get("lyrics")), query)
    return build_result(
        source="Musixmatch",
        provider="musixmatch",
        lines=lines,
        attempted_sources=attempted_sources,
        metadata={
            "track": track.get("track_name") or query.get("track"),
            "artist": track.get("artist_name") or query.get("artist"),
            "album": track.get("album_name") or query.get("album"),
        },
        result_type="line",
    )


def run_provider(provider_key, payload, query, attempted_sources):
    if provider_key == "ytmusic":
        return fetch_ytmusic(payload, query, attempted_sources)
    if provider_key == "apple_music":
        return fetch_apple_music(query, attempted_sources)
    if provider_key == "qq_music":
        return fetch_qq_music(query, attempted_sources)
    if provider_key == "musixmatch":
        return fetch_musixmatch(query, attempted_sources)
    if provider_key == "lrclib":
        return fetch_lrclib(query, attempted_sources)
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

    if preferred_source == "auto":
        line_candidate = None
        for provider_key in PROVIDER_ORDER:
            result = run_provider(provider_key, payload, query, attempted_sources)
            if not result:
                continue
            if result.get("type") == "word":
                result["attemptedSources"] = list(attempted_sources)
                return result
            if line_candidate is None and result.get("type") == "line":
                line_candidate = result
        if line_candidate:
            line_candidate["attemptedSources"] = list(attempted_sources)
            return line_candidate
        return build_missing_result(query, attempted_sources)

    result = run_provider(preferred_source, payload, query, attempted_sources)
    if result:
        result["attemptedSources"] = list(attempted_sources)
        return result
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
