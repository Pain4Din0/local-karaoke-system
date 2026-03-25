import json
import os
import re
import sys

for stream_name in ("stdin", "stdout", "stderr"):
    try:
        getattr(sys, stream_name).reconfigure(encoding="utf-8")
    except Exception:
        pass

try:
    from ytmusicapi import YTMusic
except Exception:
    YTMusic = None


SEARCH_FILTERS = {"all", "songs", "albums", "artists", "singles"}
SUPPORTED_ACTIONS = {"search", "detail"}
SUPPORTED_LANGUAGES = {
    "en",
    "ja",
    "zh_CN",
    "zh_TW",
}
LANGUAGE_FALLBACKS = {
    "zh_CN": ("ja", "en", "zh_TW"),
    "zh_TW": ("ja", "en", "zh_CN"),
    "ja": ("en", "zh_CN", "zh_TW"),
    "en": ("ja", "zh_CN", "zh_TW"),
}
LANGUAGE_ALIASES = {
    "zh": "zh_CN",
    "zh-cn": "zh_CN",
    "zh_cn": "zh_CN",
    "zh-tw": "zh_TW",
    "zh_tw": "zh_TW",
    "ja-jp": "ja",
    "en-us": "en",
    "en-gb": "en",
}
SINGLE_MARKERS = (
    "single",
    "singles",
    "single & ep",
    "single and ep",
    "ep",
    "e.p.",
    "mini album",
    "mini-album",
    "シングル",
    "シングルとep",
    "シングルと ep",
    "ミニアルバム",
    "单曲",
    "单曲和迷你专辑",
    "迷你专辑",
    "單曲",
    "單曲和迷你專輯",
    "迷你專輯",
)
YEAR_RE = re.compile(r"(19|20)\d{2}")
METRIC_TEXT_RE = re.compile(r"\d")
ALL_SECTION_ORDER = ("songs", "albums", "singles", "artists")
ALL_SECTION_WEIGHTS = {
    "songs": 3,
    "albums": 1,
    "singles": 1,
    "artists": 1,
}
NON_ARTIST_METADATA_PREFIXES = (
    "播放次数",
    "觀看次數",
    "观看次数",
    "再生回数",
    "每月观众",
    "每月觀眾",
    "月间听众",
    "月間聽眾",
    "每月听众",
    "每月聽眾",
    "monthly listeners",
    "monthly audience",
    "monthly viewers",
    "views",
    "view count",
    "subscribers",
    "subscriber count",
)


def read_payload():
    try:
        return json.load(sys.stdin)
    except Exception:
        return {}


def write_payload(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))


def fail(code, message, details=None):
    write_payload({
        "ok": False,
        "code": code,
        "message": message,
        "details": details or {},
    })


def normalize_space(value):
    return " ".join(str(value or "").split()).strip()


def normalize_query_key(value):
    return re.sub(r"[\W_]+", "", normalize_space(value).casefold())


def is_non_artist_metadata_text(value):
    text = normalize_space(value)
    if not text:
        return False
    lowered = text.casefold()
    if any(lowered.startswith(prefix) for prefix in NON_ARTIST_METADATA_PREFIXES):
        return ":" in text or "：" in text or METRIC_TEXT_RE.search(text) is not None
    if METRIC_TEXT_RE.search(text) is None:
        return False
    return any(keyword in lowered for keyword in (
        " views",
        " view",
        " subscribers",
        " subscriber",
        " listeners",
        " audience",
        " viewers",
        "播放次数",
        "觀看次數",
        "观看次数",
        "再生回数",
        "每月观众",
        "每月觀眾",
        "月间听众",
        "月間聽眾",
        "每月听众",
        "每月聽眾",
    ))


def normalize_language(value):
    text = normalize_space(value).replace("-", "_")
    if not text:
        return "en"
    lowered = text.lower()
    if lowered in LANGUAGE_ALIASES:
        return LANGUAGE_ALIASES[lowered]
    if text in SUPPORTED_LANGUAGES:
        return text
    return "en"


def build_language_fallbacks(language):
    primary = normalize_language(language)
    ordered = []
    seen = {primary}
    for candidate in LANGUAGE_FALLBACKS.get(primary, ()):
        normalized = normalize_language(candidate)
        if normalized in seen:
            continue
        seen.add(normalized)
        ordered.append(normalized)
    for candidate in ("ja", "en", "zh_CN", "zh_TW"):
        normalized = normalize_language(candidate)
        if normalized in seen:
            continue
        seen.add(normalized)
        ordered.append(normalized)
    return ordered


def parse_int(value):
    try:
        return int(value)
    except Exception:
        return None


def get_client_for_language(language, client_cache=None):
    normalized = normalize_language(language)
    if isinstance(client_cache, dict) and normalized in client_cache:
        return client_cache[normalized]
    client = YTMusic(language=normalized)
    if isinstance(client_cache, dict):
        client_cache[normalized] = client
    return client


def normalize_release_year(value):
    text = normalize_space(value)
    if not text:
        return ""
    if len(text) == 4 and text.isdigit():
        return text
    return ""


def build_watch_url(video_id, playlist_id=None):
    video_id = normalize_space(video_id)
    playlist_id = normalize_space(playlist_id)
    if not video_id:
        return ""
    if playlist_id:
        return f"https://music.youtube.com/watch?v={video_id}&list={playlist_id}"
    return f"https://music.youtube.com/watch?v={video_id}"


def build_browse_url(browse_id):
    browse_id = normalize_space(browse_id)
    if not browse_id:
        return ""
    return f"https://music.youtube.com/browse/{browse_id}"


def strip_playlist_prefix(value):
    text = normalize_space(value)
    if text.startswith("VL"):
        return text[2:]
    return text


def format_duration_text(value):
    seconds = parse_int(value)
    if not seconds or seconds <= 0:
        return None
    minutes, remain = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    if hours > 0:
        return f"{hours}:{minutes:02d}:{remain:02d}"
    return f"{minutes}:{remain:02d}"


def normalize_artists(value, fallback=None):
    artists = []

    if isinstance(value, list):
        for item in value:
            if isinstance(item, dict):
                name = normalize_space(item.get("name"))
                if name and not is_non_artist_metadata_text(name):
                    artists.append({
                        "name": name,
                        "id": normalize_space(item.get("id")) or None,
                    })
            else:
                name = normalize_space(item)
                if name and not is_non_artist_metadata_text(name):
                    artists.append({"name": name, "id": None})
    elif isinstance(value, dict):
        name = normalize_space(value.get("name"))
        if name and not is_non_artist_metadata_text(name):
            artists.append({"name": name, "id": normalize_space(value.get("id")) or None})
    else:
        name = normalize_space(value)
        if name and not is_non_artist_metadata_text(name):
            artists.append({"name": name, "id": None})

    if not artists and fallback:
        fallback_name = normalize_space(fallback)
        if fallback_name and not is_non_artist_metadata_text(fallback_name):
            artists.append({"name": fallback_name, "id": None})

    return artists


def extract_primary_artist_ref(item):
    if not isinstance(item, dict):
        return None
    artists = item.get("artists")
    if isinstance(artists, list):
        for artist in artists:
            if not isinstance(artist, dict):
                continue
            name = normalize_space(artist.get("name"))
            artist_id = normalize_space(artist.get("id"))
            if name and artist_id:
                return {"name": name, "id": artist_id}
    return None


def join_artist_names(artists):
    return ", ".join(
        item["name"]
        for item in artists
        if isinstance(item, dict) and normalize_space(item.get("name"))
    )


def normalize_album_ref(value, fallback_name=None, fallback_id=None, release_kind=None):
    if isinstance(value, dict):
        name = normalize_space(value.get("name"))
        if not name:
            name = normalize_space(fallback_name)
        album_id = normalize_space(value.get("id")) or normalize_space(fallback_id) or None
        if not name:
            return None
        resolved_kind = normalize_space(release_kind).lower()
        if resolved_kind not in {"album", "single"}:
            resolved_kind = infer_release_kind(value, default_kind="album")
        payload = {"name": name, "id": album_id}
        if resolved_kind in {"album", "single"}:
            payload["searchFilter"] = "singles" if resolved_kind == "single" else "albums"
        return payload

    name = normalize_space(value) or normalize_space(fallback_name)
    if not name:
        return None
    album_id = normalize_space(fallback_id) or None
    resolved_kind = normalize_space(release_kind).lower()
    payload = {"name": name, "id": album_id}
    if resolved_kind in {"album", "single"}:
        payload["searchFilter"] = "singles" if resolved_kind == "single" else "albums"
    return payload


def build_track_subtitle(artists, album=None, duration_text=None, extra_parts=None):
    parts = []
    artist_text = join_artist_names(artists)
    if artist_text:
        parts.append(artist_text)
    if album and normalize_space(album.get("name")):
        parts.append(album["name"])
    if duration_text:
        parts.append(duration_text)
    if isinstance(extra_parts, list):
        for item in extra_parts:
            text = normalize_space(item)
            if text:
                parts.append(text)
    return " • ".join(parts)


def build_entity_subtitle(*parts):
    return " • ".join(filter(None, (normalize_space(item) for item in parts)))


def dedupe_items(items):
    deduped = []
    seen = {}

    def richness_score(item):
        if not isinstance(item, dict):
            return -1
        score = 0
        if normalize_space(item.get("title")):
            score += 1
        if normalize_space(item.get("subtitle")):
            score += 1
        if normalize_space((item.get("albumRef") or {}).get("name")):
            score += 3
        if normalize_space((item.get("albumRef") or {}).get("id")):
            score += 1
        if normalize_space(item.get("durationText")):
            score += 1
        if isinstance(item.get("artists"), list):
            score += sum(
                1
                for artist in item.get("artists")
                if isinstance(artist, dict) and normalize_space(artist.get("name"))
            )
        return score

    for item in items:
        if not isinstance(item, dict):
            continue
        key = item.get("browseId") or item.get("videoId") or item.get("sourceId") or item.get("id") or item.get("title")
        if not key:
            continue
        if key not in seen:
            seen[key] = len(deduped)
            deduped.append(item)
            continue
        existing_index = seen[key]
        existing_item = deduped[existing_index]
        if richness_score(item) > richness_score(existing_item):
            deduped[existing_index] = item
    return deduped


def has_section_results(section):
    return bool(isinstance(section, dict) and (section.get("results") or []))


def section_needs_fallback(section_key, section):
    if section_key in {"albums", "singles"}:
        if not isinstance(section, dict):
            return True
        return (
            not (section.get("results") or [])
            or not normalize_space(section.get("params"))
            or not normalize_space(section.get("browseId"))
        )
    if section_key == "songs":
        if not isinstance(section, dict):
            return True
        return not (section.get("results") or []) or not normalize_space(section.get("browseId"))
    if section_key == "related":
        return not has_section_results(section)
    return False


def merge_artist_section(primary_section, fallback_section, fallback_language, section_key):
    if section_key in {"albums", "singles", "songs"}:
        primary = dict(primary_section) if isinstance(primary_section, dict) else {}
        fallback = fallback_section if isinstance(fallback_section, dict) else {}
        if not primary.get("results") and fallback.get("results"):
            primary["results"] = fallback.get("results")
            primary["_language"] = fallback_language
        if not primary.get("browseId") and fallback.get("browseId"):
            primary["browseId"] = fallback.get("browseId")
        if not primary.get("params") and fallback.get("params"):
            primary["params"] = fallback.get("params")
            primary["_language"] = primary.get("_language") or fallback_language
        return primary

    if section_key == "related":
        if not has_section_results(primary_section) and has_section_results(fallback_section):
            merged = dict(fallback_section)
            merged["_language"] = fallback_language
            return merged
    return primary_section


def resolve_artist_detail(client, browse_id, language, client_cache=None, required_sections=None):
    normalized_language = normalize_language(language)
    artist = client.get_artist(browse_id)
    required_sections = tuple(required_sections or ("albums", "singles", "songs"))

    missing_sections = [
        section_key
        for section_key in required_sections
        if section_needs_fallback(section_key, artist.get(section_key))
    ]
    if not missing_sections:
        return artist

    resolved = dict(artist)
    for fallback_language in build_language_fallbacks(normalized_language):
        fallback_client = get_client_for_language(fallback_language, client_cache=client_cache)
        fallback_artist = fallback_client.get_artist(browse_id)

        if not normalize_space(resolved.get("description")) and normalize_space(fallback_artist.get("description")):
            resolved["description"] = fallback_artist.get("description")

        for section_key in missing_sections:
            resolved[section_key] = merge_artist_section(
                resolved.get(section_key),
                fallback_artist.get(section_key),
                fallback_language,
                section_key,
            )

        missing_sections = [
            section_key
            for section_key in required_sections
            if section_needs_fallback(section_key, resolved.get(section_key))
        ]
        if not missing_sections:
            break

    return resolved


def extract_year_text(value):
    text = normalize_space(value)
    if not text:
        return ""
    match = YEAR_RE.search(text)
    if not match:
        return ""
    return match.group(0)


def is_single_like_text(value):
    text = normalize_space(value).casefold()
    if not text:
        return False
    return any(marker in text for marker in SINGLE_MARKERS)


def infer_release_kind(item, default_kind="album"):
    if not isinstance(item, dict):
        return default_kind

    explicit_kind = normalize_space(item.get("releaseKind")).lower()
    if explicit_kind in {"album", "single"}:
        return explicit_kind

    result_type = normalize_space(item.get("resultType")).lower()
    if result_type in {"single", "ep"}:
        return "single"

    for candidate in (
        item.get("category"),
        item.get("type"),
        item.get("year"),
    ):
        if is_single_like_text(candidate):
            return "single"

    return default_kind


def normalize_release_meta(item, fallback_artist=None):
    raw_artists = normalize_artists(item.get("artists"), fallback=item.get("artist") or fallback_artist)
    display_artists = []
    year_text = extract_year_text(item.get("year")) or extract_year_text(item.get("type"))

    for artist in raw_artists:
        name = normalize_space(artist.get("name") if isinstance(artist, dict) else artist)
        if not name:
            continue
        derived_year = extract_year_text(name)
        if derived_year:
            if not year_text:
                year_text = derived_year
            continue
        display_artists.append({
            "name": name,
            "id": artist.get("id") if isinstance(artist, dict) else None,
        })

    if not display_artists and fallback_artist:
        display_artists = normalize_artists(fallback_artist)

    return {
        "artists": display_artists,
        "artistText": join_artist_names(display_artists),
        "yearText": year_text,
    }


def normalize_track_item(
    item,
    default_result_type="song",
    default_artists=None,
    default_album=None,
    default_album_id=None,
    default_album_kind=None,
    default_playlist_id=None,
):
    if not isinstance(item, dict):
        return None

    video_id = normalize_space(item.get("videoId"))
    title = normalize_space(item.get("title"))
    if not video_id or not title:
        return None

    artists = normalize_artists(item.get("artists"), fallback=item.get("artist") or default_artists)
    album = normalize_album_ref(
        item.get("album"),
        fallback_name=default_album,
        fallback_id=default_album_id,
        release_kind=default_album_kind,
    )
    duration_seconds = parse_int(item.get("duration_seconds") or item.get("durationSeconds") or item.get("lengthSeconds"))
    duration_text = normalize_space(item.get("duration")) or format_duration_text(duration_seconds)
    result_type = normalize_space(item.get("resultType")) or default_result_type
    playlist_id = strip_playlist_prefix(item.get("playlistId") or default_playlist_id)
    subtitle = build_track_subtitle(artists, album=album, duration_text=duration_text)
    artist_text = join_artist_names(artists)

    return {
        "id": f"track:{video_id}",
        "itemType": "track",
        "resultType": result_type or "song",
        "title": title,
        "subtitle": subtitle,
        "duration": duration_seconds,
        "durationText": duration_text,
        "videoId": video_id,
        "playlistId": playlist_id or None,
        "artists": artists,
        "albumRef": album,
        "uploader": artist_text or normalize_space(item.get("author")) or "Unknown",
        "artist": artist_text or normalize_space(item.get("author")) or "Unknown",
        "album": album["name"] if album else "",
        "track": title,
        "sourceId": video_id,
        "extractor": "Youtube",
        "originalUrl": build_watch_url(video_id, playlist_id),
        "sourcePlatform": "ytmusic",
    }


def normalize_release_item(item, release_kind="album", fallback_artist=None):
    if not isinstance(item, dict):
        return None
    browse_id = normalize_space(item.get("browseId"))
    title = normalize_space(item.get("title"))
    if not browse_id or not title:
        return None

    resolved_kind = infer_release_kind(item, default_kind=release_kind)
    release_meta = normalize_release_meta(item, fallback_artist=fallback_artist)
    subtitle = build_entity_subtitle(
        release_meta["artistText"],
        release_meta["yearText"],
    )
    playlist_id = strip_playlist_prefix(item.get("playlistId") or item.get("audioPlaylistId"))

    return {
        "id": f"{resolved_kind}:{browse_id}",
        "itemType": resolved_kind,
        "title": title,
        "subtitle": subtitle,
        "browseId": browse_id,
        "playlistId": playlist_id or None,
        "resultType": resolved_kind,
        "openAction": {
            "kind": "album",
            "browseId": browse_id,
        },
        "originalUrl": build_browse_url(browse_id),
    }


def normalize_artist_item(item):
    if not isinstance(item, dict):
        return None
    primary_artist = extract_primary_artist_ref(item)
    browse_id = normalize_space(item.get("browseId") or (primary_artist or {}).get("id"))
    title = normalize_space(item.get("artist") or item.get("title") or (primary_artist or {}).get("name"))
    if not browse_id or not title:
        return None

    return {
        "id": f"artist:{browse_id}",
        "itemType": "artist",
        "title": title,
        "subtitle": "",
        "browseId": browse_id,
        "resultType": "artist",
        "openAction": {
            "kind": "artist",
            "browseId": browse_id,
        },
        "originalUrl": build_browse_url(browse_id),
    }


def is_artist_result(item):
    return isinstance(item, dict) and normalize_space(item.get("resultType")).lower() == "artist"


def is_top_result_artist(item):
    return is_artist_result(item) and normalize_space(item.get("category")).casefold() == "top result"


def has_music_artist_signal(item):
    if not isinstance(item, dict):
        return False
    if normalize_space(item.get("radioId")) or normalize_space(item.get("shuffleId")):
        return True
    return is_top_result_artist(item) and extract_primary_artist_ref(item) is not None


def artist_name_match_score(item, query):
    normalized_query = normalize_query_key(query)
    if not normalized_query:
        return 0
    artist_ref = extract_primary_artist_ref(item) or {}
    name = normalize_space(item.get("artist") or item.get("title") or artist_ref.get("name"))
    normalized_name = normalize_query_key(name)
    if not normalized_name:
        return 0
    if normalized_name == normalized_query:
        return 400
    if normalized_name.startswith(normalized_query):
        return 300
    if normalized_query in normalized_name:
        return 220
    if normalized_name in normalized_query:
        return 160
    return 0


def select_artist_search_items(raw_results, artist_results, query, requested_filter):
    candidates = []
    if requested_filter == "all":
        candidates.extend([
            item
            for item in (raw_results or [])
            if is_top_result_artist(item)
        ])
    candidates.extend([
        item
        for item in (artist_results or [])
        if is_artist_result(item)
    ])

    scored = []
    require_match = requested_filter in {"all", "artists"}
    seen_ids = set()
    for item in candidates:
        if not has_music_artist_signal(item):
            continue
        normalized_item = normalize_artist_item(item)
        if not normalized_item:
            continue
        score = artist_name_match_score(item, query)
        if require_match and score <= 0 and not is_top_result_artist(item):
            continue
        browse_id = normalized_item.get("browseId")
        if browse_id in seen_ids:
            continue
        seen_ids.add(browse_id)
        if is_top_result_artist(item):
            score += 1000
        elif normalize_query_key(normalized_item.get("title")) == normalize_query_key(query):
            score += 200
        scored.append((score, normalized_item))

    scored.sort(key=lambda pair: (-pair[0], pair[1].get("title", "")))

    if requested_filter == "all":
        exact_scored = [
            (score, item)
            for score, item in scored
            if normalize_query_key(item.get("title")) == normalize_query_key(query)
        ]
        if exact_scored:
            scored = exact_scored

    deduped_by_name = []
    seen_names = set()
    for score, item in scored:
        normalized_name = normalize_query_key(item.get("title"))
        if normalized_name and normalized_name in seen_names:
            continue
        if normalized_name:
            seen_names.add(normalized_name)
        deduped_by_name.append(item)

    return deduped_by_name[:4 if requested_filter == "artists" else 3]


def normalize_search_result(item):
    if not isinstance(item, dict):
        return None
    result_type = normalize_space(item.get("resultType")).lower()
    if result_type == "song":
        return normalize_track_item(item, default_result_type="song")
    if result_type == "album":
        return normalize_release_item(item)
    if result_type in {"single", "ep"}:
        return normalize_release_item(item, release_kind="single")
    if result_type == "artist":
        return normalize_artist_item(item)
    return None


def append_section_item(section_map, key, item):
    if item is None:
        return
    section_map.setdefault(key, []).append(item)


def allocate_all_section_limits(section_map, total_limit):
    total = max(parse_int(total_limit) or 24, 1)
    available_keys = [
        key
        for key in ALL_SECTION_ORDER
        if section_map.get(key)
    ]
    if not available_keys:
        return {}

    allocation = {}
    exact_targets = []
    total_weight = sum(ALL_SECTION_WEIGHTS.get(key, 1) for key in available_keys) or len(available_keys)

    for index, key in enumerate(available_keys):
        exact_target = total * ALL_SECTION_WEIGHTS.get(key, 1) / total_weight
        base_count = min(int(exact_target), len(section_map[key]))
        allocation[key] = base_count
        exact_targets.append((exact_target - int(exact_target), index, key))

    remaining = total - sum(allocation.values())
    for _, _, key in sorted(exact_targets, key=lambda item: (-item[0], item[1])):
        if remaining <= 0:
            break
        if allocation[key] >= len(section_map[key]):
            continue
        allocation[key] += 1
        remaining -= 1

    while remaining > 0:
        consumed = False
        for key in available_keys:
            if allocation[key] >= len(section_map[key]):
                continue
            allocation[key] += 1
            remaining -= 1
            consumed = True
            if remaining <= 0:
                break
        if not consumed:
            break

    return allocation


def build_search_sections(items, requested_filter, limit=None):
    section_map = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        item_type = item.get("itemType")
        if item_type == "track":
            result_type = normalize_space(item.get("resultType")).lower()
            if result_type == "video":
                continue
            key = "songs"
        elif item_type == "album":
            key = "albums"
        elif item_type == "single":
            key = "singles"
        elif item_type == "artist":
            key = "artists"
        else:
            continue
        append_section_item(section_map, key, item)

    if requested_filter in SEARCH_FILTERS and requested_filter != "all":
        ordered_keys = [requested_filter]
    else:
        ordered_keys = list(ALL_SECTION_ORDER)

    available_keys = [
        key
        for key in ordered_keys
        if key in section_map and section_map[key]
    ]
    if requested_filter in SEARCH_FILTERS and requested_filter != "all":
        normalized_limit = max(parse_int(limit) or 24, 1)
        section_limits = {
            key: normalized_limit
            for key in available_keys
        }
    else:
        section_limits = allocate_all_section_limits(section_map, limit)

    sections = []
    for key in available_keys:
        limited_items = section_map[key][:section_limits.get(key, len(section_map[key]))]
        if not limited_items:
            continue
        sections.append({
            "key": key,
            "items": limited_items,
        })
    return sections


def build_playlist_detail(playlist, title_override=None):
    tracks = [
        track
        for track in (
            normalize_track_item(item, default_playlist_id=playlist.get("id"))
            for item in (playlist.get("tracks") or [])
        )
        if track
    ]

    author = playlist.get("author") or {}
    if isinstance(author, dict):
        author_text = author.get("name")
    else:
        author_text = author

    return {
        "kind": "playlist",
        "title": normalize_space(title_override) or normalize_space(playlist.get("title")),
        "subtitle": build_entity_subtitle(author_text),
        "description": normalize_space(playlist.get("description")),
        "tracks": tracks,
        "sections": [],
    }


def build_album_detail(album, browse_id_override=None):
    default_album = normalize_space(album.get("title"))
    default_artists = join_artist_names(normalize_artists(album.get("artists")))
    default_album_id = normalize_space(browse_id_override or album.get("browseId") or album.get("id"))
    tracks = [
        track
        for track in (
            normalize_track_item(
                item,
                default_artists=default_artists,
                default_album=default_album,
                default_album_id=default_album_id,
                default_album_kind="album",
                default_playlist_id=album.get("audioPlaylistId"),
            )
            for item in (album.get("tracks") or [])
        )
        if track
    ]

    return {
        "kind": "album",
        "title": default_album,
        "subtitle": build_entity_subtitle(
            default_artists,
            album.get("year"),
        ),
        "description": normalize_space(album.get("description")),
        "tracks": tracks,
        "sections": [],
    }


def build_artist_section(key, title, items, open_action=None):
    normalized_items = [item for item in items if item]
    if not normalized_items:
        return None
    section = {
        "key": key,
        "title": title,
        "items": normalized_items,
    }
    if open_action:
        section["openAction"] = open_action
    return section


def build_artist_detail(artist):
    name = normalize_space(artist.get("name"))
    sections = []

    songs_info = artist.get("songs") or {}
    song_items = [
        normalize_track_item(item, default_artists=name)
        for item in (songs_info.get("results") or [])
    ]
    if songs_info.get("browseId"):
        songs_action = {
            "kind": "playlist",
            "playlistId": songs_info.get("browseId"),
            "title": name,
        }
    else:
        songs_action = None
    section = build_artist_section("songs", "songs", song_items, songs_action)
    if section:
        sections.append(section)

    for collection_key in ("albums", "singles"):
        collection = artist.get(collection_key) or {}
        collection_items = [
            normalize_release_item(
                item,
                release_kind="single" if collection_key == "singles" else "album",
                fallback_artist=name,
            )
            for item in (collection.get("results") or [])
        ]
        open_action = None
        if collection.get("browseId") and collection.get("params"):
            open_action = {
                "kind": "artist_collection",
                "channelId": collection.get("browseId"),
                "params": collection.get("params"),
                "collection": collection_key,
                "title": name,
            }
            if collection.get("_language"):
                open_action["language"] = collection.get("_language")
        section = build_artist_section(collection_key, collection_key, collection_items, open_action)
        if section:
            sections.append(section)

    related_info = artist.get("related") or {}
    related_items = [
        normalize_artist_item({
            "browseId": item.get("browseId"),
            "artist": item.get("title"),
            "subscribers": item.get("subscribers"),
            "thumbnails": item.get("thumbnails"),
        })
        for item in (related_info.get("results") or [])
    ]
    section = build_artist_section("related", "related", related_items)
    if section:
        sections.append(section)

    return {
        "kind": "artist",
        "title": name,
        "subtitle": "",
        "description": normalize_space(artist.get("description")),
        "tracks": [],
        "sections": sections,
    }


def build_artist_collection_detail(items, title, collection_key):
    releases = [
        normalize_release_item(
            item,
            release_kind="single" if collection_key == "singles" else "album",
            fallback_artist=title,
        )
        for item in items
    ]
    return {
        "kind": "artist_collection",
        "title": normalize_space(title),
        "subtitle": "",
        "tracks": [],
        "sections": [
            {
                "key": collection_key,
                "title": collection_key,
                "items": [item for item in releases if item],
            }
        ],
    }


def handle_search(client, payload, client_cache=None):
    query = normalize_space(payload.get("query"))
    requested_filter = normalize_space(payload.get("filter")).lower() or "all"
    if requested_filter not in SEARCH_FILTERS:
        requested_filter = "all"

    if not query:
        write_payload({
            "ok": True,
            "action": "search",
            "query": "",
            "filter": requested_filter,
            "sections": [],
        })
        return

    limit = min(max(parse_int(payload.get("limit")) or 24, 1), 120)
    language = normalize_language(payload.get("language"))

    if requested_filter == "all":
        base_filters = ["songs", None, "albums"]
    elif requested_filter in {"albums", "singles"}:
        base_filters = ["albums"]
    else:
        base_filters = [requested_filter]

    raw_results = []
    prioritized_items = []
    artist_results = []
    for search_filter in base_filters:
        raw_results.extend(client.search(query, filter=search_filter, limit=limit, ignore_spelling=False) or [])

    if requested_filter in {"all", "albums", "singles", "artists"}:
        artist_results = client.search(query, filter="artists", limit=min(max(limit, 6), 12), ignore_spelling=False) or []

    if requested_filter in {"all", "albums", "singles"}:
        exact_artist = next((
            item for item in artist_results
            if normalize_space(item.get("artist") or item.get("title")).casefold() == query.casefold()
        ), None)
        if exact_artist and exact_artist.get("browseId"):
            try:
                artist_detail = resolve_artist_detail(
                    client,
                    exact_artist["browseId"],
                    language,
                    client_cache=client_cache,
                    required_sections=("albums", "singles"),
                )
                if requested_filter == "albums":
                    collection_keys = ("albums",)
                elif requested_filter == "singles":
                    collection_keys = ("singles",)
                else:
                    collection_keys = ("albums", "singles")

                for collection_key in collection_keys:
                    collection = artist_detail.get(collection_key) or {}
                    prioritized_items.extend([
                        {
                            **item,
                            "releaseKind": "single" if collection_key == "singles" else "album",
                            "resultType": "single" if collection_key == "singles" else "album",
                            "artist": normalize_space(exact_artist.get("artist") or exact_artist.get("title")),
                        }
                        for item in (collection.get("results") or [])
                        if isinstance(item, dict)
                    ])
            except Exception:
                pass

    artist_items = select_artist_search_items(raw_results, artist_results, query, requested_filter)
    non_artist_results = [result for result in raw_results if not is_artist_result(result)]

    normalized_items = dedupe_items(
        artist_items + [
            item for item in (normalize_search_result(result) for result in prioritized_items + non_artist_results) if item
        ]
    )

    write_payload({
        "ok": True,
        "action": "search",
        "query": query,
        "filter": requested_filter,
        "sections": build_search_sections(normalized_items, requested_filter, limit=limit),
    })


def handle_detail(client, payload, client_cache=None):
    kind = normalize_space(payload.get("kind"))

    if kind == "album":
        browse_id = normalize_space(payload.get("browseId"))
        if not browse_id:
            fail("invalid_request", "Missing album browseId.")
            return
        detail = build_album_detail(client.get_album(browse_id), browse_id_override=browse_id)
    elif kind == "playlist":
        playlist_id = strip_playlist_prefix(payload.get("playlistId"))
        if not playlist_id:
            fail("invalid_request", "Missing playlistId.")
            return
        limit = parse_int(payload.get("limit"))
        detail = build_playlist_detail(
            client.get_playlist(playlist_id, limit=min(max(limit or 200, 1), 500)),
            title_override=payload.get("title"),
        )
    elif kind == "artist":
        browse_id = normalize_space(payload.get("browseId"))
        if not browse_id:
            fail("invalid_request", "Missing artist browseId.")
            return
        detail = build_artist_detail(
            resolve_artist_detail(
                client,
                browse_id,
                payload.get("language"),
                client_cache=client_cache,
                required_sections=("albums", "singles", "songs"),
            )
        )
    elif kind == "artist_collection":
        channel_id = normalize_space(payload.get("channelId"))
        params = normalize_space(payload.get("params"))
        collection = normalize_space(payload.get("collection")).lower() or "albums"
        title = normalize_space(payload.get("title"))
        if not channel_id or not params:
            fail("invalid_request", "Missing artist collection metadata.")
            return
        limit = parse_int(payload.get("limit"))
        items = client.get_artist_albums(channel_id, params, limit=min(max(limit or 100, 1), 500))
        detail = build_artist_collection_detail(items, title or channel_id, collection)
    else:
        fail("invalid_request", "Unsupported detail kind.", {"kind": kind})
        return

    write_payload({
        "ok": True,
        "action": "detail",
        "detail": detail,
    })


def main():
    payload = read_payload()
    action = normalize_space(payload.get("action")).lower()
    if action not in SUPPORTED_ACTIONS:
        fail("invalid_request", "Unsupported action.", {"action": action})
        return

    if YTMusic is None:
        fail(
            "missing_dependency",
            "ytmusicapi is not installed on the host.",
            {"hint": "Install ytmusicapi or run start.bat to provision optional Python dependencies."},
        )
        return

    try:
        request_language = normalize_language(payload.get("language"))
        client = YTMusic(language=request_language)
        client_cache = {request_language: client}
        if action == "search":
            handle_search(client, payload, client_cache=client_cache)
            return
        handle_detail(client, payload, client_cache=client_cache)
    except Exception as error:
        fail(
            "upstream_failed",
            str(error) or "YouTube Music request failed.",
            {"action": action},
        )


if __name__ == "__main__":
    main()
