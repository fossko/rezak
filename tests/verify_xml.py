"""Stdlib xmeml structural checks; stdin XML -> JSON tree for xml.test.ts.

Not an NLE import test or a DTD validator. Checks reference identity, source
bounds/rates, timeline bounds, channel routing, and reciprocal linked clips.
"""
import json
import sys
import xml.etree.ElementTree as ET


def integer(element, path):
    text = element.findtext(path)
    assert text is not None and text.lstrip("-").isdigit(), (path, text)
    return int(text)


def rate(element):
    r = element.find("rate")
    assert r is not None
    base = integer(r, "timebase")
    assert 0 < base <= 240
    ntsc = r.findtext("ntsc")
    assert ntsc in ("TRUE", "FALSE")
    return base, ntsc


def validate(root):
    assert root.tag == "xmeml" and root.get("version") == "5"
    sequence = root.find("sequence")
    assert sequence is not None
    duration = integer(sequence, "duration")
    assert duration > 0
    sequence_rate = rate(sequence)
    assert rate(sequence.find("timecode")) == sequence_rate
    definitions = {}
    for f in root.iter("file"):
        assert f.get("id")
        if len(f):
            assert f.get("id") not in definitions, "duplicate file definition"
            definitions[f.get("id")] = f
            assert f.findtext("pathurl", "").startswith("file://localhost/")
            assert integer(f, "duration") > 0
            rate(f)
    locations = {}
    for media in ("video", "audio"):
        for track_index, track in enumerate(sequence.findall(f"media/{media}/track"), 1):
            previous_end = 0
            for clip_index, clip in enumerate(track.findall("clipitem"), 1):
                ident = clip.get("id")
                assert ident and ident not in locations, "duplicate clip id"
                locations[ident] = (media, track_index, clip_index, clip)
                start, end = integer(clip, "start"), integer(clip, "end")
                assert previous_end <= start < end <= duration, "track overlap or out of bounds"
                previous_end = end
                f = definitions[clip.find("file").get("id")]
                assert rate(clip) == rate(f)
                assert integer(clip, "duration") == integer(f, "duration")
                assert 0 <= integer(clip, "in") < integer(clip, "out") <= integer(f, "duration")
                assert clip.findtext("sourcetrack/mediatype") == media
                source_track = integer(clip, "sourcetrack/trackindex")
                if media == "audio":
                    assert 1 <= source_track <= integer(f, "media/audio/channelcount")
                    assert source_track == track_index
                else:
                    assert source_track == 1 and f.find("media/video") is not None
    assert locations, "sequence has no media clips"
    for ident, (_, _, _, clip) in locations.items():
        refs = [link.findtext("linkclipref") for link in clip.findall("link")]
        assert ident in refs and len(refs) == len(set(refs))
        for link in clip.findall("link"):
            target_id = link.findtext("linkclipref")
            media, track_index, clip_index, target = locations[target_id]
            assert link.findtext("mediatype") == media
            assert integer(link, "trackindex") == track_index
            assert integer(link, "clipindex") == clip_index
            target_file = definitions[target.find("file").get("id")]
            if media == "audio" and integer(target_file, "media/audio/channelcount") == 2:
                assert integer(link, "groupindex") == 1, "stereo channels must share a pair"
            else:
                assert link.find("groupindex") is None, "only stereo audio links form a pair"
            assert set(refs) == {x.findtext("linkclipref") for x in target.findall("link")}
            for field in ("start", "end", "in", "out"):
                assert clip.findtext(field) == target.findtext(field)
            assert clip.find("file").get("id") == target.find("file").get("id")
    return root


def tree(element):
    return {"tag": element.tag, "attrs": element.attrib,
            "text": element.text or "", "children": [tree(c) for c in element]}


if __name__ == "__main__":
    print(json.dumps(tree(validate(ET.fromstring(sys.stdin.read()))), ensure_ascii=False))
