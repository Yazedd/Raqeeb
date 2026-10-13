"""Exercise incident provenance, persistence, and the video HTTP contract."""
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from http.server import ThreadingHTTPServer

from video_cameras import CameraLibrary, PersonIDs, box_iou, discover_videos, make_video_handler, weapon_kind, weapon_owner


class VideoCameraTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.video = root / "clip.mp4"
        self.video.write_bytes(bytes(range(256)))
        self.library = object.__new__(CameraLibrary)
        self.library.lock = threading.RLock()
        self.library.evidence = root
        self.library.incident_path = root / "incidents.json"
        self.library.incidents = []
        self.library.cache = root
        self.library.cameras = {"CAM-01": {"path": self.video, "status": "ready"}}
        self.library.analyses = {"CAM-01": {"events": [
            {"id": "real-gun", "camera": "CAM-01", "class": "gun"},
            {"id": "real-knife", "camera": "CAM-01", "class": "knife"}]}}
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_video_handler(self.library))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def test_weapon_labels_exclude_phone_and_purse(self):
        for label in ("Pistol", "handgun", "Rifle", "gun"):
            self.assertEqual(weapon_kind(label), "gun")
        self.assertEqual(weapon_kind("Knife"), "knife")
        for label in ("Smartphone", "Purse", "Card", "person"):
            self.assertIsNone(weapon_kind(label))

    def test_reconcile_archives_false_alerts_and_deduplicates_real_ones(self):
        event = {"id": "stable-gun", "camera": "CAM-01", "class": "gun", "time": 4.8,
                 "end": 22, "box": [10, 10, 30, 30]}
        self.library.incidents = [
            {**event, "id": "old-gun-a", "time": 5, "status": "Under Review"},
            {**event, "id": "old-gun-b", "time": 17, "status": "New"},
            {**event, "id": "false-counter", "time": 0, "end": 21, "status": "New"}]
        self.library.reconcile_incidents({"camera": "CAM-01", "events": [event]})
        self.assertEqual(len(self.library.incidents), 2)
        self.assertEqual(self.library.incidents[0]["id"], "stable-gun")
        self.assertEqual(self.library.incidents[0]["status"], "Under Review")
        self.assertEqual(self.library.incidents[1]["status"], "False Positive")

    def test_weapon_person_overlap(self):
        self.assertGreater(box_iou([152, 612, 264, 880], [153, 606, 267, 882]), .65)
        self.assertLess(box_iou([373, 148, 482, 238], [399, 157, 539, 424]), .65)

    def test_only_actual_detection_events_can_activate(self):
        with self.assertRaises(ValueError):
            self.library.activate("CAM-01", "invented-event")
        gun = self.library.activate("CAM-01", "real-gun")
        knife = self.library.activate("CAM-01", "real-knife")
        self.assertEqual({gun["class"], knife["class"]}, {"gun", "knife"})
        self.assertEqual(gun["status"], "New")
        self.library.activate("CAM-01", "real-gun")
        self.assertEqual(len(self.library.incidents), 2)
        self.assertEqual(len(json.loads(self.library.incident_path.read_text())), 2)

    def test_video_range_requests_and_head(self):
        req = urllib.request.Request(self.base + "/api/cameras/CAM-01/video", headers={"Range": "bytes=10-29"})
        with urllib.request.urlopen(req) as response:
            self.assertEqual(response.status, 206)
            self.assertEqual(response.headers["Content-Range"], "bytes 10-29/256")
            self.assertEqual(response.read(), bytes(range(10, 30)))
        req = urllib.request.Request(self.base + "/api/cameras/CAM-01/video", method="HEAD")
        with urllib.request.urlopen(req) as response:
            self.assertEqual(response.headers["Content-Length"], "256")
            self.assertEqual(response.read(), b"")

    def test_invalid_range_and_unknown_camera(self):
        for path, headers, status in [
            ("/api/cameras/CAM-01/video", {"Range": "bytes=999-"}, 416),
            ("/api/cameras/CAM-99/video", {}, 404),
            ("/api/evidence/../../server.py", {}, 404)]:
            with self.assertRaises(urllib.error.HTTPError) as cm:
                urllib.request.urlopen(urllib.request.Request(self.base + path, headers=headers))
            self.assertEqual(cm.exception.code, status)
            cm.exception.close()

    def test_status_changes_persist(self):
        self.library.activate("CAM-01", "real-knife")
        req = urllib.request.Request(self.base + "/api/incidents/status",
            data=json.dumps({"id": "real-knife", "status": "Resolved"}).encode(),
            headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req) as response:
            self.assertEqual(json.load(response)["status"], "Resolved")
        self.assertEqual(json.loads(self.library.incident_path.read_text())[0]["status"], "Resolved")

    def test_discovery_ignores_csv_and_json(self):
        self.assertEqual(discover_videos(self.temp.name), [self.video.resolve()])

    def test_person_ids_are_global_and_persist(self):
        path = Path(self.temp.name) / "people.json"
        people = PersonIDs(path)
        first = people.resolve("source-one", 1)
        second = people.resolve("source-two", 1)
        self.assertNotEqual(first, second)
        self.assertRegex(first, r"^P-\d{4}$")
        self.assertEqual(people.resolve("source-one", 1), first)
        self.assertEqual(PersonIDs(path).resolve("source-one", 1), first)

    def test_weapon_is_linked_to_nearby_person_id(self):
        persons = [{"id": "P-0001", "box": [0, 0, 100, 200]},
                   {"id": "P-0002", "box": [200, 0, 300, 200]}]
        self.assertEqual(weapon_owner({"box": [170, 40, 200, 60]}, persons), "P-0002")
        self.assertIsNone(weapon_owner({"box": [900, 900, 920, 920]}, persons))


if __name__ == "__main__":
    unittest.main()
