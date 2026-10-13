import importlib.util
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import ThreadingHTTPServer
from pathlib import Path

from live_webcam import LiveConfirmation, MAX_FRAME_BYTES, WebcamEngine, WebcamError, unique_people
from video_cameras import CameraLibrary, PersonIDs, make_video_handler


def weapon(kind="gun", person="P-0001"):
    return {"class": kind, "person_id": person, "conf": .9, "box": [1, 2, 20, 25], "weapon": True}


class ConfirmationTests(unittest.TestCase):
    def test_overlapping_duplicate_body_is_suppressed_but_nearby_person_is_kept(self):
        people=[{"raw_id":1,"box":[0,0,100,200],"conf":.9},
                {"raw_id":2,"box":[5,5,105,205],"conf":.4},
                {"raw_id":3,"box":[70,0,170,200],"conf":.8}]
        self.assertEqual([p['raw_id'] for p in unique_people(people)],[1,3])

    def test_gun_requires_two_distinct_processed_frames(self):
        gate=LiveConfirmation()
        self.assertEqual(gate.update([weapon(),weapon()],0),([],[]))
        confirmed,visible=gate.update([weapon()],1.5)
        self.assertEqual(len(confirmed),1)
        self.assertEqual(len(visible),1)

    def test_knife_requires_three_observations(self):
        gate=LiveConfirmation()
        for t in (0,1): self.assertEqual(gate.update([weapon("knife")],t),([],[]))
        self.assertEqual(len(gate.update([weapon("knife")],2)[0]),1)

    def test_continuous_threat_does_not_duplicate(self):
        gate=LiveConfirmation()
        gate.update([weapon()],0)
        gate.update([weapon()],1)
        self.assertEqual(gate.update([weapon()],2)[0],[])

    def test_different_holders_do_not_confirm_each_other(self):
        gate=LiveConfirmation()
        gate.update([weapon(person="P-0001")],0)
        self.assertEqual(gate.update([weapon(person="P-0002")],1),([],[]))

    def test_unassociated_and_phone_candidates_never_alert(self):
        gate=LiveConfirmation()
        for t in range(5):
            self.assertEqual(gate.update([weapon(person=None),weapon("Smartphone")],t),([],[]))

    def test_two_misses_clear_pending_and_long_absence_rearms_episode(self):
        gate=LiveConfirmation()
        gate.update([weapon()],0);gate.update([],1);gate.update([],2)
        self.assertEqual(gate.update([weapon()],3),([],[]))
        self.assertEqual(len(gate.update([weapon()],4)[0]),1)
        self.assertEqual(gate.update([weapon()],16),([],[]))
        self.assertEqual(len(gate.update([weapon()],17)[0]),1)


class WebcamSessionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        root=Path(self.temp.name)
        library=object.__new__(CameraLibrary)
        library.runtime=library.cache=library.evidence=root
        library.lock=threading.RLock();library.cameras={};library.analyses={}
        library.person_ids=PersonIDs(root/'people.json')
        library.incident_path=root/'incidents.json';library.incidents=[]
        library.webcam=WebcamEngine(library)
        self.library=library;self.engine=library.webcam

    def tearDown(self): self.temp.cleanup()

    def test_start_is_exclusive_stop_requires_owner(self):
        first=self.engine.start()
        with self.assertRaises(WebcamError) as error: self.engine.start()
        self.assertEqual(error.exception.status,409)
        with self.assertRaises(WebcamError): self.engine.stop("wrong-owner")
        self.engine.stop(first['session'])
        with self.assertRaises(WebcamError): self.engine.check(first['session'])
        second=self.engine.start()
        self.assertNotEqual(first['session'],second['session'])

    def test_stop_invalidates_a_frame_before_it_can_publish(self):
        token=self.engine.start()['session']
        self.engine.stop(token)
        with self.assertRaises(WebcamError): self.engine.process(token,b'not-a-frame')
        self.assertEqual(self.library.cameras['WEB-01']['status'],'paused')
        self.assertEqual(self.library.incidents,[])

    def test_idle_session_expires(self):
        token=self.engine.start()['session']
        self.engine.last_seen-=31;self.engine.expire()
        with self.assertRaises(WebcamError): self.engine.check(token)

    def test_restart_waits_for_an_old_inflight_frame_to_finish(self):
        token=self.engine.start()['session']
        self.engine.processing.acquire()
        try:
            self.engine.stop(token)
            with self.assertRaises(WebcamError) as error:self.engine.start()
            self.assertEqual(error.exception.status,409)
        finally:self.engine.processing.release()
        self.assertTrue(self.engine.start()['session'])

    def test_person_ids_are_unique_under_concurrent_live_and_recorded_resolution(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            ids=list(pool.map(lambda n:self.library.person_ids.resolve('source',n),range(30)))
        self.assertEqual(len(set(ids)),30)
        self.assertEqual(len(json.loads(self.library.person_ids.path.read_text())),30)

    def test_frame_http_contract_rejects_invalid_types_sizes_and_sessions(self):
        server=ThreadingHTTPServer(('127.0.0.1',0),make_video_handler(self.library))
        worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
        try:
            base=f'http://127.0.0.1:{server.server_port}/api/webcam/frame'
            for headers,status in [({'Content-Type':'text/plain'},415),
                                   ({'Content-Type':'image/jpeg'},403),
                                   ({'Content-Type':'image/jpeg','Content-Length':str(MAX_FRAME_BYTES+1)},413)]:
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(urllib.request.Request(base,data=b'frame',headers=headers))
                self.assertEqual(error.exception.code,status)
                error.exception.close()
        finally:
            server.shutdown();server.server_close();worker.join()

    @unittest.skipUnless(importlib.util.find_spec('cv2'),"OpenCV is installed in the project virtual environment")
    def test_invalid_image_does_not_load_models_or_create_evidence(self):
        token=self.engine.start()['session']
        with self.assertRaises(WebcamError):self.engine.process(token,b'not-a-jpeg')
        self.assertIsNone(self.engine.models)
        self.assertEqual(self.library.incidents,[])


if __name__=='__main__': unittest.main()
