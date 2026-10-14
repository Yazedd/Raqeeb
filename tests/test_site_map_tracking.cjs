const test=require('node:test');
const assert=require('node:assert/strict');
const {position,markers}=require('../site-map-tracking.js');
const camera={id:'CAM-01',width:100,height:100};
const anchor={id:'CAM-01',pos:[10,11,20],yaw:0,fov:60,range:100};
const person=(id='P-0001')=>({class:'person',id,box:[40,20,60,80]});
const event=(status='New')=>({id:'incident-1',camera:'CAM-01',person_id:'P-0001',box:[40,20,60,40],status});
const input=(extra={})=>({cameras:[camera],placements:[anchor],observations:[{camera:'CAM-01',dets:[person(),person('P-0002')],time:2}],incidents:[],...extra});

test('estimated placement follows the foot point inside the camera coverage',()=>{
  const result=position(anchor,person().box,100,100);
  assert.equal(result.estimated,true);assert.equal(result.at[0],10);
  assert(Math.abs(result.at[2]-48)<1e-8);
});
test('calibrated homography projects normalized image coordinates',()=>{
  const result=position({...anchor,floor_homography:[100,0,10,0,200,20,0,0,1]},person().box,100,100);
  assert.deepEqual(result,{at:[60,3,180],estimated:false});
});
test('invalid dimensions and singular calibrations produce no marker',()=>{
  assert.equal(position(anchor,person().box,0,100),null);
  assert.equal(position({...anchor,floor_homography:[0,0,0,0,0,0,0,0,0]},person().box,100,100),null);
});
test('person IDs are deduplicated without merging different people',()=>{
  const result=markers(input({observations:[{camera:'CAM-01',dets:[person(),person(),person('P-0002')]}]}));
  assert.equal(result.people.length,2);
});
test('only the incident holder becomes red, and its incident is not duplicated',()=>{
  const result=markers(input({incidents:[event()]}));
  assert.equal(result.people.find(p=>p.id==='P-0001').alert,true);
  assert.equal(result.people.find(p=>p.id==='P-0002').alert,false);
  assert.equal(result.incidents.length,0);
});
test('resolved and false-positive incidents stop highlighting the person',()=>{
  for(const status of ['Resolved','False Positive']) {
    const result=markers(input({incidents:[event(status)]}));
    assert(result.people.every(p=>!p.alert));assert.equal(result.incidents.length,0);
  }
});
test('an incident remains at its saved person position after the person leaves view',()=>{
  const result=markers(input({observations:[],incidents:[{...event(),map_box:person().box}]}));
  assert.equal(result.incidents.length,1);
  assert.deepEqual(result.incidents[0].at,position(anchor,person().box,100,100).at);
});
test('multiple open incidents for an absent holder share one marker',()=>{
  const result=markers(input({observations:[],incidents:[event(),{...event(),id:'incident-2'}]}));
  assert.equal(result.incidents.length,1);assert.equal(result.incidents[0].incidents.length,2);
});
test('unplaced cameras are disclosed rather than assigned invented coordinates',()=>{
  const result=markers(input({placements:[]}));
  assert.equal(result.people.length,0);assert.deepEqual(result.unplaced,['CAM-01']);
});
test('a webcam can use an explicitly selected plan position',()=>{
  const result=markers(input({cameras:[{...camera,id:'WEB-01'}],observations:[{camera:'WEB-01',dets:[person()]}],bindings:{'WEB-01':'CAM-01'}}));
  assert.equal(result.people.length,1);assert.equal(result.people[0].camera,'WEB-01');
});
test('offline or stale sources never generate moving person dots',()=>{
  assert.equal(markers(input({connected:false,incidents:[event()]})).people.length,0);
  assert.equal(markers(input({observations:[{camera:'CAM-01',dets:[person()],stale:true}]})).people.length,0);
});
test('a failed source does not retain current person markers',()=>{
  assert.equal(markers(input({cameras:[{...camera,status:'error'}]})).people.length,0);
});
