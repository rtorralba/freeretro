import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createEmptySession,
  mergeSessions,
  hasSessionDifferences,
  generateId,
  getCardVoteCount
} from '../js/storage.js';

test('hasSessionDifferences: accurately detects session equality and mutations', () => {
  const base = createEmptySession({ id: 'retro-test', title: 'Sprint Retro' });
  const copy = structuredClone(base);

  assert.equal(hasSessionDifferences(base, copy), false, 'Identical cloned sessions should have no differences');
  assert.equal(hasSessionDifferences(base, base), false, 'Same object reference should have no differences');

  // Title change
  const changedTitle = structuredClone(base);
  changedTitle.title = 'New Title';
  assert.equal(hasSessionDifferences(base, changedTitle), true, 'Title change should be detected');

  // Settings change
  const changedPhase = structuredClone(base);
  changedPhase.settings.phase = 'vote';
  assert.equal(hasSessionDifferences(base, changedPhase), true, 'Phase change should be detected');

  // Card addition
  const withCard = structuredClone(base);
  withCard.cards['c1'] = {
    id: 'c1',
    columnId: 'col-keep',
    text: 'Good job',
    authorId: 'u1',
    updatedAt: 100,
    deleted: false
  };
  assert.equal(hasSessionDifferences(base, withCard), true, 'Card addition should be detected');

  // Vote change
  const withVote = structuredClone(withCard);
  withVote.cards['c1'].votes = { u2: { count: 1, updatedAt: 200 } };
  assert.equal(hasSessionDifferences(withCard, withVote), true, 'Vote change should be detected');

  // Comment change
  const withComment = structuredClone(withVote);
  withComment.cards['c1'].comments = { cm1: { id: 'cm1', text: 'Agree', updatedAt: 300, deleted: false } };
  assert.equal(hasSessionDifferences(withVote, withComment), true, 'Comment change should be detected');
});

test('Concurrency: 10 participants creating cards simultaneously converge to identical state', () => {
  const initial = createEmptySession({ id: 'retro-room-10', title: 'Retro 10 Peers' });
  const peers = Array.from({ length: 10 }, (_, i) => ({
    userId: `user-${i + 1}`,
    name: `Dev ${i + 1}`,
    session: structuredClone(initial)
  }));

  // Each peer creates 3 cards locally in different columns
  peers.forEach((peer, i) => {
    for (let c = 0; c < 3; c++) {
      const cardId = `card-p${i}-c${c}`;
      const colId = peer.session.columns[c % peer.session.columns.length].id;
      peer.session.cards[cardId] = {
        id: cardId,
        columnId: colId,
        text: `Insight ${c} from Dev ${i + 1}`,
        authorId: peer.userId,
        authorName: peer.name,
        done: false,
        votes: {},
        comments: {},
        createdAt: 1000 + i * 10 + c,
        updatedAt: 1000 + i * 10 + c,
        deleted: false
      };
      peer.session.updatedAt = 1000 + i * 10 + c;
    }
  });

  // Total cards created = 10 * 3 = 30 cards
  // Simulate mesh peer-to-peer sync in random pairwise encounters
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < peers.length; i++) {
      const partnerIdx = (i + 1 + round) % peers.length;
      const mergedA = mergeSessions(peers[i].session, peers[partnerIdx].session);
      const mergedB = mergeSessions(peers[partnerIdx].session, peers[i].session);
      peers[i].session = mergedA;
      peers[partnerIdx].session = mergedB;
    }
  }

  // Final check: All 10 peers must have exactly 30 cards, 0 lost
  const refPeerCards = Object.keys(peers[0].session.cards).sort();
  assert.equal(refPeerCards.length, 30, 'Peer 0 must have all 30 cards');

  for (let i = 1; i < peers.length; i++) {
    const peerCards = Object.keys(peers[i].session.cards).sort();
    assert.deepEqual(peerCards, refPeerCards, `Peer ${i} cards must match Peer 0 exactly`);
    assert.equal(hasSessionDifferences(peers[0].session, peers[i].session), false, `Peer ${i} must have 0 state differences from Peer 0`);
  }
});

test('Concurrency: Simultaneous voting on the same cards from multiple participants', () => {
  const base = createEmptySession({ id: 'retro-vote-test' });
  const sharedCardId = 'target-card';
  base.cards[sharedCardId] = {
    id: sharedCardId,
    columnId: 'col-keep',
    text: 'Architecture discussion',
    authorId: 'u1',
    votes: {},
    comments: {},
    createdAt: 100,
    updatedAt: 100,
    deleted: false
  };

  // 5 participants vote on target-card simultaneously
  const participants = ['alice', 'bob', 'charlie', 'david', 'emma'];
  const states = participants.map((user, idx) => {
    const s = structuredClone(base);
    s.cards[sharedCardId].votes[user] = {
      count: idx + 1, // Alice: 1, Bob: 2, Charlie: 3, David: 4, Emma: 5
      updatedAt: 200 + idx
    };
    s.cards[sharedCardId].updatedAt = 200 + idx;
    s.updatedAt = 200 + idx;
    return s;
  });

  // Merge all into one session in arbitrary order
  let finalState = structuredClone(base);
  for (const s of states) {
    finalState = mergeSessions(finalState, s);
  }

  const mergedCard = finalState.cards[sharedCardId];
  assert.equal(Object.keys(mergedCard.votes).length, 5, 'Must preserve votes from all 5 distinct participants');
  assert.equal(mergedCard.votes['alice'].count, 1);
  assert.equal(mergedCard.votes['bob'].count, 2);
  assert.equal(mergedCard.votes['charlie'].count, 3);
  assert.equal(mergedCard.votes['david'].count, 4);
  assert.equal(mergedCard.votes['emma'].count, 5);

  const totalVotes = getCardVoteCount(mergedCard);
  assert.equal(totalVotes, 1 + 2 + 3 + 4 + 5, 'Total vote count must sum up correctly without any drops');
});

test('Concurrency: Card deletion vs concurrent voting and commenting', () => {
  const base = createEmptySession({ id: 'retro-delete-race' });
  const cardId = 'contested-card';
  base.cards[cardId] = {
    id: cardId,
    columnId: 'col-start',
    text: 'Try mob programming',
    authorId: 'u1',
    votes: {},
    comments: {},
    createdAt: 100,
    updatedAt: 100,
    deleted: false
  };

  // User A logically deletes the card at T = 500
  const stateA = structuredClone(base);
  stateA.cards[cardId].deleted = true;
  stateA.cards[cardId].updatedAt = 500;
  stateA.updatedAt = 500;

  // User B votes and adds a comment at T = 300 (earlier)
  const stateB = structuredClone(base);
  stateB.cards[cardId].votes['u2'] = { count: 1, updatedAt: 300 };
  stateB.cards[cardId].comments['cm1'] = { id: 'cm1', text: 'Love this idea', authorId: 'u2', createdAt: 300, updatedAt: 300, deleted: false };
  stateB.cards[cardId].updatedAt = 300;
  stateB.updatedAt = 300;

  // Merge A then B
  const merge1 = mergeSessions(stateA, stateB);
  assert.equal(merge1.cards[cardId].deleted, true, 'Deletion at T=500 must win over earlier edit at T=300');
  assert.ok(merge1.cards[cardId].comments['cm1'], 'Comment metadata is preserved in CRDT tombstone');
  assert.ok(merge1.cards[cardId].votes['u2'], 'Vote metadata is preserved in CRDT tombstone');

  // Merge B then A (commutative property)
  const merge2 = mergeSessions(stateB, stateA);
  assert.equal(merge2.cards[cardId].deleted, true, 'Deletion must win regardless of merge argument order');
  assert.equal(hasSessionDifferences(merge1, merge2), false, 'Merge order must be commutative');
});

test('Concurrency: Phase transition and blur reveal while cards are added concurrently', () => {
  const base = createEmptySession({ id: 'retro-phase-race' });
  base.settings.cardsBlurred = true;
  base.settings.phase = 'write';
  base.settings.updatedAt = 100;

  // Coordinator reveals cards and switches to 'group' phase at T = 400
  const coordinatorState = structuredClone(base);
  coordinatorState.settings.cardsBlurred = false;
  coordinatorState.settings.phase = 'group';
  coordinatorState.settings.updatedAt = 400;
  coordinatorState.updatedAt = 400;

  // Participant adds card at T = 350
  const participantState = structuredClone(base);
  participantState.cards['new-card'] = {
    id: 'new-card',
    columnId: 'col-keep',
    text: 'Keep daily sync short',
    authorId: 'u3',
    updatedAt: 350,
    deleted: false
  };
  participantState.updatedAt = 350;

  const merged = mergeSessions(coordinatorState, participantState);
  assert.equal(merged.settings.cardsBlurred, false, 'Cards must be revealed (coordinator updatedAt 400 > 100)');
  assert.equal(merged.settings.phase, 'group', 'Phase must be group');
  assert.ok(merged.cards['new-card'], 'Concurrently added card must not be lost');
  assert.equal(merged.cards['new-card'].text, 'Keep daily sync short');
});

