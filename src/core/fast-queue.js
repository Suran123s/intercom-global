// src/core/fast-queue.js - High-Throughput Local In-Memory Event Queue with Safe-Path Disk Fallback
const { EventEmitter } = require('events');
const { MessageEnvelope } = require('./message');

function validateAgent(name) {
  try {
    const { validateAgentName } = require('./mesh');
    return validateAgentName(name);
  } catch (err) {
    if (err.name === 'SecurityError') throw err;
    if (typeof name !== 'string' || !name.trim()) throw new Error('Invalid agent name');
    return name.trim();
  }
}

const PRIORITY_LEVELS = {
  LOW: 1,
  NORMAL: 2,
  HIGH: 3,
  CRITICAL: 4
};

const MAX_WILDCARD_CACHE_SIZE = 500;
const MAX_PATTERN_LENGTH = 256;
const MAX_REGEX_WILDCARDS = 8;
const wildcardRegexCache = new Map();

/**
 * Linear-time glob matching for patterns with excessive wildcards to prevent ReDoS
 */
function matchWildcardLinear(text, pattern) {
  let ti = 0;
  let pi = 0;
  let starIdx = -1;
  let matchIdx = 0;

  while (ti < text.length) {
    if (pi < pattern.length && pattern[pi] === text[ti]) {
      ti++;
      pi++;
    } else if (pi < pattern.length && pattern[pi] === '*') {
      starIdx = pi;
      matchIdx = ti;
      pi++;
    } else if (starIdx !== -1) {
      pi = starIdx + 1;
      matchIdx++;
      ti = matchIdx;
    } else {
      return false;
    }
  }
  while (pi < pattern.length && pattern[pi] === '*') {
    pi++;
  }
  return pi === pattern.length;
}

function matchesWildcardPattern(value, pattern) {
  if (typeof pattern !== 'string') return false;
  if (pattern.length > MAX_PATTERN_LENGTH) return false;
  if (!pattern.includes('*')) return value === pattern;

  const normalized = pattern.replace(/\*+/g, '*');
  const starCount = (normalized.match(/\*/g) || []).length;
  if (starCount > MAX_REGEX_WILDCARDS) {
    return matchWildcardLinear(value, normalized);
  }

  let regex = wildcardRegexCache.get(normalized);
  if (!regex) {
    const escaped = normalized.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    try {
      regex = new RegExp(`^${escaped}$`);
    } catch {
      return false;
    }
    if (wildcardRegexCache.size >= MAX_WILDCARD_CACHE_SIZE) {
      const oldestKey = wildcardRegexCache.keys().next().value;
      if (oldestKey !== undefined) wildcardRegexCache.delete(oldestKey);
    }
    wildcardRegexCache.set(normalized, regex);
  }
  return regex.test(value);
}

class SubscriptionFilter {
  /**
   * Evaluates if a message envelope matches filter criteria
   * @param {object} msg 
   * @param {object} filter 
   * @returns {boolean}
   */
  static matches(msg, filter = {}) {
    if (!filter || Object.keys(filter).length === 0) return true;
    if (!msg) return false;

    // Type filter
    if (filter.type || filter.types) {
      const allowed = Array.isArray(filter.type || filter.types)
        ? (filter.type || filter.types)
        : [filter.type || filter.types];
      const matchType = allowed.some((pattern) => {
        if (typeof pattern !== 'string') return false;
        if (pattern.endsWith('*')) {
          const prefix = pattern.slice(0, -1);
          return (msg.type || '').startsWith(prefix);
        }
        return msg.type === pattern;
      });
      if (!matchType) return false;
    }

    // Channel filter
    if (filter.channel || filter.channels) {
      const allowed = Array.isArray(filter.channel || filter.channels)
        ? (filter.channel || filter.channels)
        : [filter.channel || filter.channels];
      const msgChannel = msg.payload?.channel || msg.channel;
      if (!msgChannel || !allowed.includes(msgChannel)) return false;
    }

    // Sender pattern (supports cached bounded wildcard *)
    if (filter.sender || filter.senders) {
      const allowed = Array.isArray(filter.sender || filter.senders)
        ? (filter.sender || filter.senders)
        : [filter.sender || filter.senders];
      const sender = msg.sender || msg.from || '';
      const matchSender = allowed.some((pattern) => matchesWildcardPattern(sender, pattern));
      if (!matchSender) return false;
    }

    // Exclude senders
    if (filter.excludeSenders || filter.exclude) {
      const excluded = Array.isArray(filter.excludeSenders || filter.exclude)
        ? (filter.excludeSenders || filter.exclude)
        : [filter.excludeSenders || filter.exclude];
      const sender = msg.sender || msg.from || '';
      const isExcluded = excluded.some((pattern) => matchesWildcardPattern(sender, pattern));
      if (isExcluded) return false;
    }

    // Correlation ID
    if (filter.correlationId) {
      const corrId = msg.correlationId || msg.payload?.correlationId;
      if (corrId !== filter.correlationId) return false;
    }

    // Priority filter (minimum threshold)
    if (filter.minPriority || filter.priority) {
      const minPriStr = (filter.minPriority || filter.priority).toUpperCase();
      const minPri = PRIORITY_LEVELS[minPriStr] || 2;
      const msgPriStr = (msg.priority || 'NORMAL').toUpperCase();
      const msgPri = PRIORITY_LEVELS[msgPriStr] || 2;
      if (msgPri < minPri) return false;
    }

    // Custom Predicate
    if (typeof filter.predicate === 'function') {
      try {
        if (!filter.predicate(msg)) return false;
      } catch {
        return false;
      }
    }

    return true;
  }

  /**
   * Parses URL query parameters into filter options
   * @param {URLSearchParams|object} params 
   * @returns {object}
   */
  static fromQuery(params) {
    const get = (key) => (typeof params.get === 'function' ? params.get(key) : params[key]);
    const filter = {};

    const types = get('types') || get('type');
    if (types) filter.types = types.split(',').map((s) => s.trim()).filter(Boolean);

    const senders = get('senders') || get('from') || get('sender');
    if (senders) filter.senders = senders.split(',').map((s) => s.trim()).filter(Boolean);

    const exclude = get('excludeSenders') || get('exclude');
    if (exclude) filter.excludeSenders = exclude.split(',').map((s) => s.trim()).filter(Boolean);

    const minPriority = get('minPriority') || get('priority');
    if (minPriority) filter.minPriority = minPriority.toUpperCase();

    const channels = get('channels') || get('channel');
    if (channels) filter.channels = channels.split(',').map((s) => s.trim()).filter(Boolean);

    const correlationId = get('correlationId');
    if (correlationId) filter.correlationId = correlationId;

    return filter;
  }
}

class FastQueue extends EventEmitter {
  constructor(options = {}) {
    super();
    this.setMaxListeners(100);
    this.maxQueueDepth = options.maxQueueDepth || options.defaultMaxQueue || 500;
    this.localAgents = new Set();
    this.agentQueues = new Map();
    this.workers = new Map(); // agent -> { handler, maxQueue, stats }
    this.stats = {
      inMemoryDelivered: 0,
      fallbackDelivered: 0,
      filteredOut: 0,
      errorsCaught: 0
    };
  }

  registerLocalAgent(agent) {
    const clean = validateAgent(agent);
    this.localAgents.add(clean);
    if (!this.agentQueues.has(clean)) {
      this.agentQueues.set(clean, []);
    }
  }

  unregisterLocalAgent(agent) {
    const clean = validateAgent(agent);
    this.localAgents.delete(clean);
    this.agentQueues.delete(clean);
    this.workers.delete(clean);
  }

  registerWorker(agentName, handler, options = {}) {
    const clean = validateAgent(agentName);
    if (typeof handler !== 'function') {
      throw new TypeError(`Handler for worker "${clean}" must be a function`);
    }

    this.registerLocalAgent(clean);
    this.workers.set(clean, {
      name: clean,
      handler,
      maxQueue: options.maxQueue || this.maxQueueDepth,
      stats: {
        delivered: 0,
        droppedToDisk: 0,
        registeredAt: new Date().toISOString()
      }
    });

    this.emit('worker:registered', { agent: clean });
    return this;
  }

  async unregisterWorker(agentName, diskFallbackFn = null) {
    const clean = validateAgent(agentName);
    const worker = this.workers.get(clean);
    const q = this.agentQueues.get(clean) || [];

    // Flush pending queue items to disk if fallback provided
    if (q.length > 0 && typeof diskFallbackFn === 'function') {
      for (const env of q) {
        try {
          await diskFallbackFn(clean, env);
          this.stats.fallbackDelivered++;
        } catch {}
      }
    }

    this.unregisterLocalAgent(clean);
    this.emit('worker:unregistered', { agent: clean });
    return Boolean(worker);
  }

  isLocal(agent) {
    if (!agent) return false;
    try {
      const clean = validateAgent(agent);
      return this.localAgents.has(clean);
    } catch {
      return false;
    }
  }

  isLocalWorker(agent) {
    return this.isLocal(agent);
  }

  async dispatch(recipient, envelopeData) {
    let cleanRecipient;
    try {
      cleanRecipient = validateAgent(recipient);
    } catch {
      cleanRecipient = recipient;
    }

    if (this.isLocal(cleanRecipient)) {
      const q = this.agentQueues.get(cleanRecipient) || [];
      const worker = this.workers.get(cleanRecipient);
      const eventName = `message:${cleanRecipient}`;
      const hasSubscribers = this.listenerCount(eventName) > 0;
      const limit = worker?.maxQueue || this.maxQueueDepth;

      this.stats.inMemoryDelivered++;

      if (worker) {
        worker.stats.delivered++;
        try {
          await worker.handler(envelopeData);
        } catch (err) {
          this.stats.errorsCaught++;
          this.emit('worker:error', { agent: cleanRecipient, error: err.message });
          // Fall back to Safe-Path disk on handler crash (do not retain in memory)
          const { writeMessage } = require('./mesh');
          await writeMessage(cleanRecipient, envelopeData);
          this.stats.fallbackDelivered++;
          return { mode: 'safe-path-file-mesh', delivered: true, fallback: true, error: err.message };
        }
        // Delivered to worker; also notify any active subscribers without retaining in agentQueues
        if (hasSubscribers) {
          this.emit(eventName, envelopeData);
        }
        return { mode: 'fast-path-memory', delivered: true, inMemory: true, envelope: envelopeData };
      }

      if (hasSubscribers) {
        // Active subscriber(s) receive the message immediately; dequeue/do not retain in agentQueues
        this.emit(eventName, envelopeData);
        return { mode: 'fast-path-memory', delivered: true, inMemory: true, envelope: envelopeData };
      }

      // No active worker or subscriber: buffer up to maxQueueDepth cap
      if (q.length >= limit) {
        q.shift(); // Evict oldest
      }
      q.push(envelopeData);
      this.agentQueues.set(cleanRecipient, q);
      return { mode: 'fast-path-memory', delivered: true, inMemory: true, envelope: envelopeData };
    }

    // External or un-registered agent: fallback to discrete file-mesh write
    const { writeMessage } = require('./mesh');
    const envelope = envelopeData instanceof MessageEnvelope
      ? envelopeData
      : {
          sender: envelopeData.sender || 'local_worker',
          type: envelopeData.type || 'task_dispatch',
          priority: envelopeData.priority || 'NORMAL',
          payload: envelopeData.payload || envelopeData
        };

    await writeMessage(cleanRecipient, envelope);
    this.stats.fallbackDelivered++;
    return { mode: 'safe-path-file-mesh', delivered: true, inMemory: false };
  }

  async dispatchLocal(recipient, envelopeData, options = {}) {
    return this.dispatch(recipient, envelopeData);
  }

  subscribe(agent, filter = {}, handler) {
    const clean = validateAgent(agent);
    if (typeof handler !== 'function') {
      throw new TypeError(`Subscriber handler for "${clean}" must be a function`);
    }
    const eventName = `message:${clean}`;
    const listener = (msg) => {
      if (this.matchesFilter(msg, filter)) {
        try {
          const result = handler(msg);
          if (result && typeof result.then === 'function') {
            result.catch((err) => {
              this.stats.errorsCaught++;
              this.emit('subscriber:error', { agent: clean, error: err?.message || String(err) });
            });
          }
        } catch (err) {
          this.stats.errorsCaught++;
          this.emit('subscriber:error', { agent: clean, error: err?.message || String(err) });
        }
      } else {
        this.stats.filteredOut++;
      }
    };
    this.on(eventName, listener);
    return () => this.off(eventName, listener);
  }

  matchesFilter(msg, filter) {
    return SubscriptionFilter.matches(msg, filter);
  }

  getStats() {
    const workerStats = {};
    for (const [name, w] of this.workers.entries()) {
      workerStats[name] = {
        queueLength: (this.agentQueues.get(name) || []).length,
        delivered: w.stats.delivered,
        droppedToDisk: w.stats.droppedToDisk,
        registeredAt: w.stats.registeredAt
      };
    }
    return {
      activeWorkers: this.localAgents.size,
      globalStats: { ...this.stats },
      workers: workerStats
    };
  }

  clear() {
    this.removeAllListeners();
    this.localAgents.clear();
    this.agentQueues.clear();
    this.workers.clear();
  }
}

const fastQueueInstance = new FastQueue();

module.exports = {
  FastQueue,
  SubscriptionFilter,
  fastQueue: fastQueueInstance
};
