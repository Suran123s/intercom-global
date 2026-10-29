// src/core/message.js - Standardized MessageEnvelope & Schema Validation
const crypto = require('crypto');

const VALID_TYPES = ['task_dispatch', 'task_response', 'interrupt', 'heartbeat', 'ack'];
const VALID_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'];
const IDENTIFIER_REGEX = /^[a-zA-Z0-9_\-]+$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DOS_DEVICE_REGEX = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]|CONIN\$|CONOUT\$|CLOCK\$)(\..*)?$/i;

/**
 * Validates a message envelope against the Draft-07 JSON Schema in ARCHITECTURE.md Section 9.1
 * @param {object} envelope 
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateMessage(envelope) {
  const errors = [];

  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { valid: false, errors: ['Envelope must be a non-null object'] };
  }

  // Required: id
  if (typeof envelope.id !== 'string') {
    errors.push('Field "id" must be a string UUIDv4');
  } else if (!UUID_REGEX.test(envelope.id)) {
    errors.push(`Field "id" ("${envelope.id}") is not a valid UUID format`);
  }

  // Required: timestamp
  if (typeof envelope.timestamp !== 'string') {
    errors.push('Field "timestamp" must be an ISO-8601 string');
  } else {
    const parsed = Date.parse(envelope.timestamp);
    if (isNaN(parsed)) {
      errors.push(`Field "timestamp" ("${envelope.timestamp}") is not a valid date-time string`);
    }
  }

  // Optional/Computed: epochMs
  if (envelope.epochMs !== undefined && (!Number.isInteger(envelope.epochMs) || envelope.epochMs < 0)) {
    errors.push('Field "epochMs" must be a non-negative integer');
  }

  // Required: sender
  if (typeof envelope.sender !== 'string' || !envelope.sender.trim()) {
    errors.push('Field "sender" must be a non-empty string');
  } else if (DOS_DEVICE_REGEX.test(envelope.sender)) {
    errors.push(`Field "sender" ("${envelope.sender}") is a reserved Windows DOS/Win32 device name`);
  } else if (!IDENTIFIER_REGEX.test(envelope.sender)) {
    errors.push(`Field "sender" ("${envelope.sender}") must match pattern ^[a-zA-Z0-9_\\-]+$`);
  }

  // Required: recipient
  if (typeof envelope.recipient !== 'string' || !envelope.recipient.trim()) {
    errors.push('Field "recipient" must be a non-empty string');
  } else if (DOS_DEVICE_REGEX.test(envelope.recipient)) {
    errors.push(`Field "recipient" ("${envelope.recipient}") is a reserved Windows DOS/Win32 device name`);
  } else if (!IDENTIFIER_REGEX.test(envelope.recipient)) {
    errors.push(`Field "recipient" ("${envelope.recipient}") must match pattern ^[a-zA-Z0-9_\\-]+$`);
  }

  // Required: type
  if (typeof envelope.type !== 'string' || !VALID_TYPES.includes(envelope.type)) {
    errors.push(`Field "type" ("${envelope.type}") must be one of: ${VALID_TYPES.join(', ')}`);
  }

  // Required: priority
  if (typeof envelope.priority !== 'string' || !VALID_PRIORITIES.includes(envelope.priority)) {
    errors.push(`Field "priority" ("${envelope.priority}") must be one of: ${VALID_PRIORITIES.join(', ')}`);
  }

  // Required: payload
  if (!envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) {
    errors.push('Field "payload" must be a non-null object');
  }

  // Optional: correlationId
  if (envelope.correlationId !== undefined && typeof envelope.correlationId !== 'string') {
    errors.push('Field "correlationId" must be a string if provided');
  }

  // Optional: parentId
  if (envelope.parentId !== undefined && typeof envelope.parentId !== 'string') {
    errors.push('Field "parentId" must be a string if provided');
  }

  // Optional: metadata
  if (envelope.metadata !== undefined && (typeof envelope.metadata !== 'object' || envelope.metadata === null || Array.isArray(envelope.metadata))) {
    errors.push('Field "metadata" must be an object if provided');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Standardized MessageEnvelope class adhering strictly to Section 9.1
 */
class MessageEnvelope {
  constructor(data = {}) {
    this.id = data.id || crypto.randomUUID();
    this.timestamp = data.timestamp || new Date().toISOString();
    this.epochMs = Number.isInteger(data.epochMs) ? data.epochMs : (Date.parse(this.timestamp) || Date.now());
    this.sender = data.sender || '';
    this.recipient = data.recipient || '';
    this.type = data.type || 'task_dispatch';
    this.priority = data.priority || 'NORMAL';
    this.payload = data.payload || {};

    if (data.correlationId) this.correlationId = String(data.correlationId);
    if (data.parentId) this.parentId = String(data.parentId);
    if (data.metadata) this.metadata = { ...data.metadata };
  }

  /**
   * Factory method to create a validated MessageEnvelope
   */
  static create(options = {}) {
    const envelope = new MessageEnvelope(options);
    const validation = validateMessage(envelope);
    if (!validation.valid) {
      const err = new Error(`Invalid MessageEnvelope: ${validation.errors.join('; ')}`);
      err.errors = validation.errors;
      throw err;
    }
    return envelope;
  }

  /**
   * Validates raw JSON object or string
   */
  static validate(rawJson) {
    if (typeof rawJson === 'string') {
      try {
        rawJson = JSON.parse(rawJson);
      } catch (e) {
        return { valid: false, errors: [`JSON parse error: ${e.message}`] };
      }
    }
    return validateMessage(rawJson);
  }

  /**
   * Parses string or object into MessageEnvelope instance
   */
  static fromJSON(rawJson) {
    const obj = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
    const validation = validateMessage(obj);
    if (!validation.valid) {
      const err = new Error(`Invalid MessageEnvelope data: ${validation.errors.join('; ')}`);
      err.errors = validation.errors;
      throw err;
    }
    return new MessageEnvelope(obj);
  }

  toJSON() {
    const obj = {
      id: this.id,
      timestamp: this.timestamp,
      epochMs: this.epochMs,
      sender: this.sender,
      recipient: this.recipient,
      type: this.type,
      priority: this.priority,
      payload: this.payload
    };
    if (this.correlationId) obj.correlationId = this.correlationId;
    if (this.parentId) obj.parentId = this.parentId;
    if (this.metadata) obj.metadata = this.metadata;
    return obj;
  }

  toString() {
    return JSON.stringify(this.toJSON(), null, 2);
  }
}

module.exports = {
  MessageEnvelope,
  validateMessage,
  VALID_TYPES,
  VALID_PRIORITIES,
  IDENTIFIER_REGEX,
  UUID_REGEX
};
