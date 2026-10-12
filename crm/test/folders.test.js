import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UNFILED, addFolder, removeFolder, findByName, folderOf, folderName, countByFolder, inFolder,
} from '../lib/folders.js';

const folders = [{ id: 'f1', name: 'Warm' }, { id: 'f2', name: 'Later' }];

const thread = (threadID, folderID) => ({ threadID, folderID });

test('a folder is added with the id the caller generated', () => {
  assert.deepEqual(addFolder([], 'Warm', 'f1'), [{ id: 'f1', name: 'Warm' }]);
  assert.deepEqual(addFolder(folders, '  Cold  leads ', 'f3').at(-1), { id: 'f3', name: 'Cold leads' });
});

test('a name that is not one, or an id that is not one, adds nothing', () => {
  // Same array back, so the caller writes nothing — the tags idiom.
  assert.equal(addFolder(folders, '   ', 'f3'), folders);
  assert.equal(addFolder(folders, 'Warm ', 'f3'), folders, 'the same name, differently spaced');
  assert.equal(addFolder(folders, 'WARM', 'f3'), folders, 'and in another case');
  assert.equal(addFolder(folders, 'Cold', ''), folders, 'no id');
  assert.equal(addFolder(undefined, 'Warm', 'f1').length, 1, 'nothing there yet is still a list');
});

test('a long name is cut, not refused', () => {
  const name = addFolder([], 'a'.repeat(40), 'f1')[0].name;
  assert.equal(name.length, 24);
});

test('findByName is how a duplicate becomes "you already have that one"', () => {
  assert.equal(findByName(folders, ' warm ')?.id, 'f1');
  assert.equal(findByName(folders, 'nope'), null);
  assert.equal(findByName(folders, ''), null);
});

test('removing a folder leaves the rest alone, and an unknown id changes nothing', () => {
  assert.deepEqual(removeFolder(folders, 'f1'), [{ id: 'f2', name: 'Later' }]);
  assert.equal(removeFolder(folders, 'nope'), folders);
});

test('a row pointing at a folder that no longer exists reads as unfiled', () => {
  // The row keeps its folderID until the unfile write lands — and that write can
  // fail. Nothing downstream may show a lead as being somewhere it is not.
  assert.equal(folderOf(thread('t1', 'f1'), folders), 'f1');
  assert.equal(folderOf(thread('t2', 'gone'), folders), '');
  assert.equal(folderOf(thread('t3'), folders), '');
  assert.equal(folderOf(undefined, folders), '');
  assert.equal(folderOf(thread('t1', 'f1'), []), '');
});

test('folderName never returns a raw id', () => {
  assert.equal(folderName(folders, 'f2'), 'Later');
  assert.equal(folderName(folders, 'gone'), '');
});

test('countByFolder counts every folder, zeros included, plus what is filed nowhere', () => {
  const counts = countByFolder(
    [thread('a', 'f1'), thread('b', 'f1'), thread('c'), thread('d', 'gone')],
    folders,
  );
  assert.equal(counts.f1, 2);
  assert.equal(counts.f2, 0, 'an empty folder still has a number, or the chip cannot say so');
  assert.equal(counts[UNFILED], 2, 'never filed, and filed into a folder that was deleted');
});

test('inFolder is a scope: no folder means everything', () => {
  const list = [thread('a', 'f1'), thread('b'), thread('c', 'f2')];
  assert.equal(inFolder(list, '', folders), list, 'the same array — nothing to filter');
  assert.deepEqual(inFolder(list, 'f1', folders).map((t) => t.threadID), ['a']);
  assert.deepEqual(inFolder(list, UNFILED, folders).map((t) => t.threadID), ['b']);
  assert.deepEqual(inFolder(list, 'gone', folders).map((t) => t.threadID), [], 'a folder that was deleted holds nobody');
});
