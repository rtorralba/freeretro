/**
 * FreeRetro - Storage, History & URL Snapshot Engine
 * Handles local persistence (localStorage), CRDT state merging,
 * URL initialization/snapshot encoding (LZ-based compression), and Markdown/JSON export.
 */

const STORAGE_KEYS = {
  SESSIONS_PREFIX: 'freeretro_session_',
  SESSION_INDEX: 'freeretro_session_index',
  USER_PROFILE: 'freeretro_user_profile',
  THEME: 'freeretro_theme'
};

export const TEMPLATES = {
  classic: {
    id: 'classic',
    name: 'Clásica completa (Hechos, Seguir, Dejar, Empezar, Agradecimientos, Acciones)',
    columns: [
      { id: 'col-facts', title: 'Hechos', subtitle: 'Datos, hitos o eventos objetivos del sprint', color: 'sky', icon: 'info' },
      { id: 'col-keep', title: 'Seguir haciendo', subtitle: 'Lo que funciona bien y debemos mantener', color: 'emerald', icon: 'check-circle' },
      { id: 'col-stop', title: 'Dejar de hacer', subtitle: 'Lo que nos frena o no aporta valor', color: 'rose', icon: 'x-circle' },
      { id: 'col-start', title: 'Empezar a hacer', subtitle: 'Nuevas ideas o experimentos a probar', color: 'amber', icon: 'sparkles' },
      { id: 'col-kudos', title: 'Agradecimientos', subtitle: 'Reconocimientos y gracias a compañeros', color: 'pink', icon: 'heart' },
      { id: 'col-actions', title: 'Plan de Acción', subtitle: 'Compromisos concretos para el próximo sprint', color: 'indigo', icon: 'target', isActionColumn: true }
    ]
  },
  fourLs: {
    id: 'fourLs',
    name: 'Las 4 Ls (Liked, Learned, Lacked, Longed for)',
    columns: [
      { id: 'col-liked', title: 'Liked (Nos gustó)', subtitle: 'Aspectos positivos del sprint', color: 'emerald', icon: 'heart' },
      { id: 'col-learned', title: 'Learned (Aprendimos)', subtitle: 'Nuevos aprendizajes técnicos o de equipo', color: 'sky', icon: 'book-open' },
      { id: 'col-lacked', title: 'Lacked (Nos faltó)', subtitle: 'Cosas que echamos en falta', color: 'rose', icon: 'alert-circle' },
      { id: 'col-longed', title: 'Longed For (Deseamos)', subtitle: 'Lo que nos gustaría tener a futuro', color: 'amber', icon: 'star' },
      { id: 'col-actions', title: 'Plan de Acción', subtitle: 'Acciones concretas asignadas', color: 'indigo', icon: 'target', isActionColumn: true }
    ]
  },
  madSadGlad: {
    id: 'madSadGlad',
    name: 'Mad, Sad, Glad (Emocional + Acciones)',
    columns: [
      { id: 'col-glad', title: 'Glad (Contentos)', subtitle: '¿Qué nos hizo sentir orgullosos o felices?', color: 'emerald', icon: 'smile' },
      { id: 'col-sad', title: 'Sad (Tristes)', subtitle: '¿Qué nos decepcionó o desmotivó?', color: 'amber', icon: 'frown' },
      { id: 'col-mad', title: 'Mad (Molestos)', subtitle: '¿Qué nos frustró o bloqueó?', color: 'rose', icon: 'flame' },
      { id: 'col-actions', title: 'Plan de Acción', subtitle: 'Qué haremos para mejorar', color: 'indigo', icon: 'target', isActionColumn: true }
    ]
  }
};

/**
 * Generates a short random ID
 */
export function generateId(prefix = '') {
  const rand = Math.random().toString(36).substring(2, 8) + Date.now().toString(36).slice(-4);
  return prefix ? `${prefix}-${rand}` : rand;
}

/**
 * Gets or creates the current user's local profile
 */
export function getUserProfile() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.USER_PROFILE);
    if (raw) {
      const profile = JSON.parse(raw);
      if (profile && profile.id && profile.name) return profile;
    }
  } catch (e) {
    console.warn('Error reading user profile:', e);
  }

  const colors = ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#0ea5e9', '#8b5cf6', '#14b8a6', '#f43f5e'];
  const newProfile = {
    id: generateId('user'),
    name: '',
    color: colors[Math.floor(Math.random() * colors.length)]
  };
  saveUserProfile(newProfile);
  return newProfile;
}

export function saveUserProfile(profile) {
  try {
    localStorage.setItem(STORAGE_KEYS.USER_PROFILE, JSON.stringify(profile));
  } catch (e) {
    console.warn('Error saving user profile:', e);
  }
}

/**
 * Creates a fresh retrospective session object
 */
export function createEmptySession({
  id = generateId('retro'),
  title = 'Retrospectiva de Sprint',
  sprint = '',
  templateId = 'classic',
  cardsBlurred = true,
  maxVotes = 5,
  createdBy = 'Organizador',
  coordinatorId = '',
  previousActions = []
} = {}) {
  const tpl = TEMPLATES[templateId] || TEMPLATES.classic;
  const now = Date.now();

  const cards = {};
  // If importing pending actions from a previous session, add them to the action column
  const actionCol = tpl.columns.find(c => c.isActionColumn) || tpl.columns[tpl.columns.length - 1];
  previousActions.forEach((act, idx) => {
    const cardId = generateId('card');
    cards[cardId] = {
      id: cardId,
      columnId: actionCol.id,
      text: `[Anterior] ${act.text}`,
      authorId: act.authorId || 'system',
      authorName: act.authorName || createdBy,
      authorColor: act.authorColor || '#6366f1',
      Assignee: act.Assignee || '',
      done: Boolean(act.done),
      votes: {},
      comments: {},
      createdAt: now + idx,
      updatedAt: now + idx,
      deleted: false
    };
  });

  return {
    id,
    title: title.trim() || 'Retrospectiva de Sprint',
    sprint: sprint.trim(),
    templateId,
    coordinatorId,
    createdAt: now,
    updatedAt: now,
    settings: {
      cardsBlurred: Boolean(cardsBlurred),
      phase: 'write', // 'write' | 'group' | 'vote' | 'actions' | 'closed'
      maxVotes: Number(maxVotes) || 5,
      anonymousCards: false,
      updatedAt: now
    },
    timer: {
      running: false,
      durationSec: 300,
      endsAt: null,
      updatedAt: 0
    },
    music: {
      playing: false,
      style: 'zen',
      updatedAt: 0
    },
    columns: tpl.columns.map((c, index) => ({
      ...c,
      order: index,
      updatedAt: now,
      deleted: false
    })),
    cards
  };
}

/**
 * CRDT Merge Function (Last-Write-Wins Element Set)
 * Safely merges two session states (e.g., cards created offline before the meeting
 * + live state from peers) without losing any participant's cards or votes.
 */
export function mergeSessions(local, remote) {
  if (!local) return structuredClone(remote);
  if (!remote) return structuredClone(local);

  const merged = structuredClone(local);

  // Meta fields
  if (!merged.coordinatorId && remote.coordinatorId) {
    merged.coordinatorId = remote.coordinatorId;
  }
  if ((remote.updatedAt || 0) > (merged.updatedAt || 0)) {
    merged.title = remote.title || merged.title;
    merged.sprint = remote.sprint ?? merged.sprint;
    if (remote.coordinatorId) merged.coordinatorId = remote.coordinatorId;
    merged.updatedAt = remote.updatedAt;
  }

  // Settings (phase, blur, maxVotes)
  if ((remote.settings?.updatedAt || 0) > (merged.settings?.updatedAt || 0)) {
    merged.settings = { ...merged.settings, ...remote.settings };
  }

  // Timer
  if ((remote.timer?.updatedAt || 0) > (merged.timer?.updatedAt || 0)) {
    merged.timer = { ...remote.timer };
  }

  // Music
  if ((remote.music?.updatedAt || 0) > (merged.music?.updatedAt || 0)) {
    merged.music = { ...remote.music };
  }

  // Columns merge by column ID
  const colMap = new Map();
  (merged.columns || []).forEach(c => colMap.set(c.id, c));
  (remote.columns || []).forEach(rc => {
    const lc = colMap.get(rc.id);
    if (!lc || (rc.updatedAt || 0) > (lc.updatedAt || 0)) {
      colMap.set(rc.id, { ...rc });
    }
  });
  merged.columns = Array.from(colMap.values()).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  // Cards merge by card ID (preserves cards created offline by any peer!)
  merged.cards = merged.cards || {};
  const remoteCards = remote.cards || {};

  for (const [cardId, rCard] of Object.entries(remoteCards)) {
    const lCard = merged.cards[cardId];
    if (!lCard) {
      merged.cards[cardId] = structuredClone(rCard);
    } else {
      // Merge card core properties using updatedAt
      const winner = (rCard.updatedAt || 0) >= (lCard.updatedAt || 0)
        ? { ...lCard, ...rCard }
        : { ...rCard, ...lCard };

      // Merge votes per userId (each user's vote entry has { count, updatedAt })
      const mergedVotes = { ...(lCard.votes || {}) };
      for (const [userId, rVote] of Object.entries(rCard.votes || {})) {
        const lVote = mergedVotes[userId];
        if (!lVote || (rVote.updatedAt || 0) >= (lVote.updatedAt || 0)) {
          mergedVotes[userId] = { ...rVote };
        }
      }
      winner.votes = mergedVotes;

      // Merge comments per commentId
      const mergedComments = { ...(lCard.comments || {}) };
      for (const [commentId, rComm] of Object.entries(rCard.comments || {})) {
        const lComm = mergedComments[commentId];
        if (!lComm || (rComm.updatedAt || 0) >= (lComm.updatedAt || 0)) {
          mergedComments[commentId] = { ...rComm };
        }
      }
      winner.comments = mergedComments;

      merged.cards[cardId] = winner;
    }
  }

  return merged;
}

/**
 * Save a session to localStorage and update the session history index
 */
export function saveSession(session) {
  if (!session || !session.id) return;
  try {
    localStorage.setItem(STORAGE_KEYS.SESSIONS_PREFIX + session.id, JSON.stringify(session));

    const index = getSessionIndex();
    const activeCards = Object.values(session.cards || {}).filter(c => !c.deleted);
    const actionColIds = new Set((session.columns || []).filter(c => c.isActionColumn).map(c => c.id));
    const actionCards = activeCards.filter(c => actionColIds.has(c.columnId));
    const pendingActions = actionCards.filter(c => !c.done).length;

    const authors = new Set(activeCards.map(c => c.authorName).filter(Boolean));

    const summary = {
      id: session.id,
      title: session.title,
      sprint: session.sprint || '',
      templateId: session.templateId || 'classic',
      createdAt: session.createdAt || Date.now(),
      updatedAt: session.updatedAt || Date.now(),
      lastVisitedAt: Date.now(),
      phase: session.settings?.phase || 'write',
      cardCount: activeCards.length,
      actionCount: actionCards.length,
      pendingActions,
      participantCount: Math.max(1, authors.size)
    };

    const existingIdx = index.findIndex(item => item.id === session.id);
    if (existingIdx >= 0) {
      index[existingIdx] = summary;
    } else {
      index.unshift(summary);
    }

    // Sort by most recently visited/updated
    index.sort((a, b) => (b.lastVisitedAt || b.updatedAt) - (a.lastVisitedAt || a.updatedAt));
    localStorage.setItem(STORAGE_KEYS.SESSION_INDEX, JSON.stringify(index));
  } catch (e) {
    console.error('Error saving session to localStorage:', e);
  }
}

/**
 * Load a session by ID from localStorage
 */
export function loadSession(sessionId) {
  if (!sessionId) return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.SESSIONS_PREFIX + sessionId);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.error('Error loading session:', e);
    return null;
  }
}

/**
 * Delete a session from localStorage
 */
export function deleteSession(sessionId) {
  try {
    localStorage.removeItem(STORAGE_KEYS.SESSIONS_PREFIX + sessionId);
    const index = getSessionIndex().filter(item => item.id !== sessionId);
    localStorage.setItem(STORAGE_KEYS.SESSION_INDEX, JSON.stringify(index));
  } catch (e) {
    console.error('Error deleting session:', e);
  }
}

/**
 * Get the list of all saved sessions sorted by date
 */
export function getSessionIndex() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.SESSION_INDEX);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

/**
 * Get pending action items from a past session so they can be carried over
 */
export function getPendingActionsFromSession(sessionId) {
  const session = loadSession(sessionId);
  if (!session) return [];
  const actionColIds = new Set((session.columns || []).filter(c => c.isActionColumn).map(c => c.id));
  return Object.values(session.cards || {})
    .filter(c => !c.deleted && actionColIds.has(c.columnId) && !c.done);
}

/**
 * URL-safe encoding / decoding using LZString (if loaded) or UTF-8 Base64URL fallback.
 * Used for:
 * 1) Initializing a session via link before anyone is online (#room=xxx&init=...)
 * 2) Sharing an async snapshot or read-only archive via URL (#room=xxx&state=...)
 */
export function encodePayloadToUrl(obj) {
  try {
    const json = JSON.stringify(obj);
    if (window.LZString && window.LZString.compressToEncodedURIComponent) {
      return 'lz_' + window.LZString.compressToEncodedURIComponent(json);
    }
    const bytes = new TextEncoder().encode(json);
    let binary = '';
    bytes.forEach(b => (binary += String.fromCharCode(b)));
    return 'b64_' + btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  } catch (e) {
    console.error('Error encoding payload:', e);
    return '';
  }
}

export function decodePayloadFromUrl(encoded) {
  if (!encoded) return null;
  try {
    if (encoded.startsWith('lz_') && window.LZString) {
      const json = window.LZString.decompressFromEncodedURIComponent(encoded.slice(3));
      return json ? JSON.parse(json) : null;
    }
    const rawB64 = encoded.startsWith('b64_') ? encoded.slice(4) : encoded;
    const base64 = rawB64.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json);
  } catch (e) {
    console.warn('Error decoding URL payload:', e);
    return null;
  }
}

/**
 * Creates a compact initialization metadata payload for the room link
 * so participants who open the link hours before the meeting get the exact
 * board title, sprint, and custom columns even if the creator is offline!
 */
export function createInitMetadata(session) {
  return {
    id: session.id,
    t: session.title,
    s: session.sprint || '',
    tpl: session.templateId || 'classic',
    cid: session.coordinatorId || '',
    b: session.settings?.cardsBlurred ? 1 : 0,
    mv: session.settings?.maxVotes || 5,
    cols: (session.columns || []).filter(c => !c.deleted).map(c => ({
      id: c.id,
      title: c.title,
      subtitle: c.subtitle,
      color: c.color,
      icon: c.icon,
      isActionColumn: Boolean(c.isActionColumn),
      order: c.order
    }))
  };
}

export function createSessionFromInitMetadata(meta) {
  const now = Date.now();
  return {
    id: meta.id,
    title: meta.t || 'Retrospectiva de Sprint',
    sprint: meta.s || '',
    templateId: meta.tpl || 'classic',
    coordinatorId: meta.cid || 'remote-coordinator',
    createdAt: now,
    updatedAt: 1, // Low timestamp so live state overrides if modified later
    settings: {
      cardsBlurred: Boolean(meta.b),
      phase: 'write',
      maxVotes: Number(meta.mv) || 5,
      anonymousCards: false,
      updatedAt: 1
    },
    timer: {
      running: false,
      durationSec: 300,
      endsAt: null,
      updatedAt: 0
    },
    music: {
      playing: false,
      style: 'zen',
      updatedAt: 0
    },
    columns: (meta.cols || TEMPLATES.classic.columns).map((c, idx) => ({
      ...c,
      order: c.order ?? idx,
      updatedAt: 1,
      deleted: false
    })),
    cards: {}
  };
}

/**
 * Export session to clean Markdown (great for GitHub Wiki, Issues, Notion, Confluence, Jira)
 */
export function exportSessionToMarkdown(session) {
  const dateStr = new Date(session.createdAt || Date.now()).toLocaleDateString('es-ES', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const lines = [];
  lines.push(`# ${session.title}${session.sprint ? ` (${session.sprint})` : ''}`);
  lines.push(`> **Fecha:** ${dateStr} | **ID de Sala:** \`${session.id}\``);
  lines.push('');

  const activeColumns = (session.columns || []).filter(c => !c.deleted).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const allCards = Object.values(session.cards || {}).filter(c => !c.deleted);

  for (const col of activeColumns) {
    lines.push(`## ${col.title}`);
    const colCards = allCards
      .filter(c => c.columnId === col.id)
      .sort((a, b) => getCardVoteCount(b) - getCardVoteCount(a) || a.createdAt - b.createdAt);

    if (colCards.length === 0) {
      lines.push('_Sin tarjetas en esta columna._');
      lines.push('');
      continue;
    }

    for (const card of colCards) {
      const votes = getCardVoteCount(card);
      const voteBadge = votes > 0 ? ` **[+${votes} votos]**` : '';
      const author = !session.settings?.anonymousCards && card.authorName ? ` _(por ${card.authorName})_` : '';
      const assignee = card.Assignee ? ` → **Responsable: @${card.Assignee}**` : '';

      if (col.isActionColumn) {
        const check = card.done ? '[x]' : '[ ]';
        lines.push(`- ${check} ${card.text}${assignee}${voteBadge}${author}`);
      } else {
        lines.push(`- ${card.text}${voteBadge}${author}`);
      }

      const comments = Object.values(card.comments || {}).filter(cm => !cm.deleted).sort((a, b) => a.createdAt - b.createdAt);
      for (const cm of comments) {
        lines.push(`  - 💬 _${cm.authorName || 'Anónimo'}:_ ${cm.text}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function getCardVoteCount(card) {
  if (!card || !card.votes) return 0;
  return Object.values(card.votes).reduce((acc, v) => acc + (Number(v.count) || 0), 0);
}

