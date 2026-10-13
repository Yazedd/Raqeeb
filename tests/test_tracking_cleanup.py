import copy
import json
import tempfile
import unittest
from pathlib import Path

from tracking_cleanup import consolidate
from video_cameras import PersonIDs


class ConsolidationTests(unittest.TestCase):
    def data(self, overlap=False):
        frames = []
        for pid, start in [('P-0001', 0), ('P-0002', .2 if overlap else .5)]:
            for i in range(4):
                frames.append({'time': round(start+i*.1, 2), 'dets': [
                    {'class': 'person', 'id': pid, 'conf': .9, 'box': [0, 0, 50, 150]}]})
        return {'frames': sorted(frames, key=lambda f: f['time']), 'events': [],
                'tracks': [{'id': pid, 'class': 'person'} for pid in ['P-0001', 'P-0002']]}

    def run_cleanup(self, data):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            registry = PersonIDs(root/'ids.json')
            registry.data = {'source:1': 'P-0001', 'source:2': 'P-0002'}
            return consolidate(data, root, registry, 'source',
                               features={'P-0001': [1, 0], 'P-0002': [1, 0]})

    def test_matching_nonoverlapping_fragments_become_one_person(self):
        result = self.run_cleanup(self.data())
        self.assertEqual([t['id'] for t in result['tracks']], ['P-0001'])
        self.assertEqual({d['id'] for f in result['frames'] for d in f['dets']}, {'P-0001'})
        self.assertEqual(result['tracks'][0]['frames'], 8)

    def test_simultaneous_people_remain_distinct_even_with_identical_features(self):
        result = self.run_cleanup(self.data(overlap=True))
        self.assertEqual(len(result['tracks']), 2)

    def test_short_isolated_track_is_removed(self):
        data = self.data()
        data['frames'] = [f for f in data['frames'] if f['time'] < .6]
        result = self.run_cleanup(data)
        self.assertEqual(len(result['tracks']), 1)

    def test_partially_occluded_person_returning_at_edge_keeps_id(self):
        data = self.data()
        for frame in data['frames']:
            if frame['dets'][0]['id'] == 'P-0001':
                frame['dets'][0]['box'] = [0, 80, 50, 150]
        result = self.run_cleanup(data)
        self.assertEqual(len(result['tracks']), 1)

    def test_cleanup_is_idempotent(self):
        result = self.run_cleanup(self.data())
        self.assertEqual(self.run_cleanup(copy.deepcopy(result)), result)


if __name__ == '__main__':
    unittest.main()
