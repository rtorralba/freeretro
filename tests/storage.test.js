import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createEmptySession,
  mergeSessions,
  getCardVoteCount
} from '../js/storage.js';

test('mergeSessions: preserves cards created concurrently by different participants', () => {
  const baseSession = createEmptySession({ id: 'room-1', title: 'Sprint Retro' });

  // Participant A adds a card
  const sessionA = structuredClone(baseSession);
  sessionA.updatedAt = 1000;
  sessionA.cards['card-a'] = {
    id: 'card-a',
    columnId: 'col-keep',
    text: 'Idea from Alice',
    authorId: 'user-a',
    authorName: 'Alice',
    createdAt: 1000,
    updatedAt: 1000,
    deleted: false,
    votes: {},
    comments: {}
  };

  // Participant B adds another card concurrently
  const sessionB = structuredClone(baseSession);
  sessionB.updatedAt = 1005;
  sessionB.cards['card-b'] = {
    id: 'card-b',
    columnId: 'col-stop',
    text: 'Idea from Bob',
    authorId: 'user-b',
    authorName: 'Bob',
    createdAt: 1005,
    updatedAt: 1005,
    deleted: false,
    votes: {},
    comments: {}
  };

  // Merge A into B
  const merged = mergeSessions(sessionA, sessionB);

  assert.ok(merged.cards['card-a'], 'Card A must be kept');
  assert.ok(merged.cards['card-b'], 'Card B must be kept');
  assert.equal(merged.cards['card-a'].text, 'Idea from Alice');
  assert.equal(merged.cards['card-b'].text, 'Idea from Bob');
});

test('mergeSessions: preserves all cards when local has cards that remote does not have yet', () => {
  const sessionA = createEmptySession({ id: 'room-1' });
  sessionA.cards['card-1'] = {
    id: 'card-1',
    columnId: 'col-keep',
    text: 'Local card',
    createdAt: 1000,
    updatedAt: 1000,
    deleted: false,
    votes: {},
    comments: {}
  };

  const sessionB = createEmptySession({ id: 'room-1' });
  sessionB.cards['card-2'] = {
    id: 'card-2',
    columnId: 'col-stop',
    text: 'Remote card',
    createdAt: 1000,
    updatedAt: 1000,
    deleted: false,
    votes: {},
    comments: {}
  };

  const merged = mergeSessions(sessionA, sessionB);
  assert.ok(merged.cards['card-1']);
  assert.ok(merged.cards['card-2']);
});

test('mergeSessions: merges concurrent votes from different users on the same card without loss', () => {
  const sessionA = createEmptySession({ id: 'room-1' });
  sessionA.cards['card-x'] = {
    id: 'card-x',
    columnId: 'col-keep',
    text: 'Great teamwork',
    createdAt: 1000,
    updatedAt: 1010,
    deleted: false,
    votes: {
      'user-1': { count: 2, updatedAt: 1010 }
    },
    comments: {}
  };

  const sessionB = createEmptySession({ id: 'room-1' });
  sessionB.cards['card-x'] = {
    id: 'card-x',
    columnId: 'col-keep',
    text: 'Great teamwork',
    createdAt: 1000,
    updatedAt: 1020,
    deleted: false,
    votes: {
      'user-2': { count: 3, updatedAt: 1020 }
    },
    comments: {}
  };

  const merged = mergeSessions(sessionA, sessionB);
  const card = merged.cards['card-x'];
  assert.equal(card.votes['user-1']?.count, 2);
  assert.equal(card.votes['user-2']?.count, 3);
  assert.equal(getCardVoteCount(card), 5);
});

test('mergeSessions: logical deletion wins if deletion timestamp is newer', () => {
  const sessionA = createEmptySession({ id: 'room-1' });
  sessionA.cards['card-del'] = {
    id: 'card-del',
    columnId: 'col-keep',
    text: 'To be deleted',
    createdAt: 1000,
    updatedAt: 1050,
    deleted: true,
    votes: {},
    comments: {}
  };

  const sessionB = createEmptySession({ id: 'room-1' });
  sessionB.cards['card-del'] = {
    id: 'card-del',
    columnId: 'col-keep',
    text: 'To be deleted',
    createdAt: 1000,
    updatedAt: 1020,
    deleted: false,
    votes: {},
    comments: {}
  };

  const merged = mergeSessions(sessionA, sessionB);
  assert.equal(merged.cards['card-del'].deleted, true);
});

test('mergeSessions: does not crash with null, undefined, malformed or empty objects', () => {
  const valid = createEmptySession({ id: 'room-1' });
  assert.deepEqual(mergeSessions(valid, null).id, valid.id);
  assert.deepEqual(mergeSessions(null, valid).id, valid.id);
  assert.doesNotThrow(() => mergeSessions({}, {}));
  assert.doesNotThrow(() => mergeSessions({ cards: null }, { cards: undefined }));
  assert.doesNotThrow(() => mergeSessions({ columns: null }, { columns: undefined }));
  assert.doesNotThrow(() => mergeSessions({ cards: { 'c-1': null } }, { cards: { 'c-1': {} } }));
});

test('mergeSessions: handles concurrent card movement across columns and comment additions', () => {
  const base = createEmptySession({ id: 'room-1' });
  base.cards['c1'] = {
    id: 'c1',
    columnId: 'col-keep',
    text: 'Task 1',
    createdAt: 1000,
    updatedAt: 1000,
    deleted: false,
    votes: {},
    comments: {}
  };

  // Peer A moved card to action column at t=2000
  const stateA = structuredClone(base);
  stateA.cards['c1'].columnId = 'col-actions';
  stateA.cards['c1'].updatedAt = 2000;

  // Peer B added a comment at t=2005 without knowing it was moved
  const stateB = structuredClone(base);
  stateB.cards['c1'].comments['cm-1'] = {
    id: 'cm-1',
    text: 'Important note',
    authorName: 'Bob',
    createdAt: 2005,
    updatedAt: 2005,
    deleted: false
  };
  stateB.cards['c1'].updatedAt = 2005;

  const merged = mergeSessions(stateA, stateB);
  assert.ok(merged.cards['c1'].comments['cm-1'], 'Comment must be preserved');
  assert.equal(merged.cards['c1'].comments['cm-1'].text, 'Important note');
});

test('mergeSessions: convergence / associativity test with 3 concurrent peers', () => {
  const p1 = createEmptySession({ id: 'room-1' });
  const p2 = createEmptySession({ id: 'room-1' });
  const p3 = createEmptySession({ id: 'room-1' });

  p1.cards['c1'] = { id: 'c1', columnId: 'col-facts', text: 'P1 note', updatedAt: 100, votes: {}, comments: {} };
  p2.cards['c2'] = { id: 'c2', columnId: 'col-keep', text: 'P2 note', updatedAt: 200, votes: {}, comments: {} };
  p3.cards['c3'] = { id: 'c3', columnId: 'col-stop', text: 'P3 note', updatedAt: 300, votes: {}, comments: {} };

  // Merge order (p1 + p2) + p3
  const m12 = mergeSessions(p1, p2);
  const m123 = mergeSessions(m12, p3);

  // Merge order p1 + (p2 + p3)
  const m23 = mergeSessions(p2, p3);
  const m1_23 = mergeSessions(p1, m23);

  assert.deepEqual(Object.keys(m123.cards).sort(), ['c1', 'c2', 'c3']);
  assert.deepEqual(Object.keys(m1_23.cards).sort(), ['c1', 'c2', 'c3']);
});
