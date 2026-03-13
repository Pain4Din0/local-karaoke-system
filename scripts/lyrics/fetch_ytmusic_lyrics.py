import json
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

try:
    from ytmusicapi import YTMusic
except Exception as exc:
    print(json.dumps({"ok": False, "error": f"ytmusicapi_import_failed:{exc}"}, ensure_ascii=True))
    raise SystemExit(0)


def normalize_text(value):
    return " ".join(str(value or "").split()).strip()


def normalize_key(value):
    value = normalize_text(value).lower()
    return "".join(ch for ch in value if ch.isalnum())


def parse_duration_seconds(value):
    try:
        if value is None:
            return None
        return int(round(float(value)))
    except Exception:
        return None


def score_result(result, track, artist, duration):
    result_title = normalize_key(result.get("title"))
    result_artists = normalize_key(" ".join(a.get("name", "") for a in result.get("artists", []) if isinstance(a, dict)))
    query_title = normalize_key(track)
    query_artist = normalize_key(artist)
    result_duration = parse_duration_seconds(result.get("duration_seconds"))

    score = 0
    if query_title:
        if result_title == query_title:
            score += 80
        elif query_title in result_title or result_title in query_title:
            score += 45

    if query_artist:
        if result_artists == query_artist:
            score += 40
        elif query_artist in result_artists or result_artists in query_artist:
            score += 20

    if duration and result_duration:
        delta = abs(duration - result_duration)
        if delta <= 2:
            score += 25
        elif delta <= 5:
            score += 15
        elif delta <= 10:
            score += 5

    return score


def find_video_id(client, payload):
    source_id = normalize_text(payload.get("sourceId"))
    if source_id:
        return source_id

    track = normalize_text(payload.get("track"))
    artist = normalize_text(payload.get("artist"))
    duration = parse_duration_seconds(payload.get("duration"))
    if not track and not artist:
        return None

    query = normalize_text(f"{track} {artist}")
    try:
        results = client.search(query, filter="songs", limit=5) or []
    except Exception:
        return None

    ranked = sorted(results, key=lambda item: score_result(item, track, artist, duration), reverse=True)
    best = ranked[0] if ranked else None
    if not best:
        return None

    if score_result(best, track, artist, duration) < 40:
        return None

    return best.get("videoId")


def meaningful_line_count(lines):
    count = 0
    for line in lines:
        text = normalize_text(line.get("text"))
        if text:
            count += 1
    return count


def is_meaningful_text(text):
    # Keep symbol-only lyric lines (e.g. ♪, ♫), as they are meaningful for karaoke status.
    return bool(normalize_text(text))


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"invalid_json:{exc}"}, ensure_ascii=True))
        return

    client = YTMusic()
    video_id = find_video_id(client, payload)
    if not video_id:
        print(json.dumps({"ok": False, "error": "video_id_not_found"}, ensure_ascii=True))
        return

    try:
        playlist = client.get_watch_playlist(videoId=video_id)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"watch_playlist_failed:{exc}", "videoId": video_id}, ensure_ascii=True))
        return

    browse_id = playlist.get("lyrics")
    if not browse_id:
        print(json.dumps({"ok": False, "error": "lyrics_browse_id_missing", "videoId": video_id}, ensure_ascii=True))
        return

    try:
        lyrics = client.get_lyrics(browse_id, timestamps=True)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"get_lyrics_failed:{exc}", "videoId": video_id, "browseId": browse_id}, ensure_ascii=True))
        return

    if not lyrics or not lyrics.get("hasTimestamps"):
        print(json.dumps({"ok": False, "error": "timed_lyrics_unavailable", "videoId": video_id, "browseId": browse_id}, ensure_ascii=True))
        return

    lines = []
    for entry in lyrics.get("lyrics", []) or []:
        text = normalize_text(getattr(entry, "text", ""))
        start_ms = getattr(entry, "start_time", None)
        end_ms = getattr(entry, "end_time", None)
        if not text or start_ms is None or not is_meaningful_text(text):
            continue
        lines.append({
            "text": text,
            "start": round(float(start_ms) / 1000, 3),
            "end": round(float(end_ms) / 1000, 3) if end_ms is not None else None,
        })

    if meaningful_line_count(lines) < 2:
        print(json.dumps({"ok": False, "error": "insufficient_meaningful_lyrics", "videoId": video_id, "browseId": browse_id}, ensure_ascii=True))
        return

    print(json.dumps({
        "ok": True,
        "source": "YouTube Music",
        "provider": "ytmusic",
        "type": "line",
        "videoId": video_id,
        "browseId": browse_id,
        "metadata": {
            "track": payload.get("track"),
            "artist": payload.get("artist"),
            "album": payload.get("album"),
        },
        "lines": lines,
    }, ensure_ascii=True))


if __name__ == "__main__":
    main()
