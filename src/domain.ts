export type Order = {
  id: string;
  showId: string;
  revision: number;
  tickets: number;
  refundedTickets: number;
  grossCents: number;
  refundedCents: number;
  currency: 'USD';
};

export type NormalizedEvent = { deliveryId: string; order: Order };
export type Summary = {
  showId: string;
  orders: number;
  netTickets: number;
  netCents: number;
  currency: 'USD';
};
export type Delivery = {
  showId: string;
  version: number;
  summary: Summary;
  attempts: number;
};
export type IngestResult = {
  status: 'accepted' | 'duplicate' | 'stale' | 'quarantined';
  reason?: string;
};

const MAX_VALUE = 1_000_000_000;
export const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function record(value: unknown, fields: string[], name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  const keys = Object.keys(value);
  if (keys.length !== fields.length || !fields.every((key) => Object.hasOwn(value, key))) {
    throw new Error(`${name} has missing or unexpected fields`);
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new Error(`${name} must be a bounded identifier`);
  }
  return value;
}

function integer(value: unknown, name: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > MAX_VALUE) {
    throw new Error(`${name} must be an integer between ${minimum} and ${MAX_VALUE}`);
  }
  return value;
}

export function normalize(input: unknown): NormalizedEvent {
  const event = record(input, ['schemaVersion', 'deliveryId', 'order'], 'event');
  const deliveryId = identifier(event.deliveryId, 'deliveryId');
  let source: Record<string, unknown>;

  if (event.schemaVersion === 1) {
    source = record(event.order, [
      'id', 'showId', 'revision', 'tickets', 'refundedTickets', 'grossCents', 'refundedCents', 'currency',
    ], 'order');
  } else if (event.schemaVersion === 2) {
    const order = record(event.order, ['id', 'showId', 'version', 'quantities', 'amounts'], 'order');
    const quantities = record(order.quantities, ['sold', 'refunded'], 'quantities');
    const amounts = record(order.amounts, ['gross', 'refunded', 'currency'], 'amounts');
    source = {
      id: order.id,
      showId: order.showId,
      revision: order.version,
      tickets: quantities.sold,
      refundedTickets: quantities.refunded,
      grossCents: amounts.gross,
      refundedCents: amounts.refunded,
      currency: amounts.currency,
    };
  } else {
    throw new Error('unsupported schemaVersion');
  }

  const id = identifier(source.id, 'order.id');
  const showId = identifier(source.showId, 'order.showId');
  const revision = integer(source.revision, 'order.revision', 1);
  const tickets = integer(source.tickets, 'order.tickets');
  const refundedTickets = integer(source.refundedTickets, 'order.refundedTickets');
  const grossCents = integer(source.grossCents, 'order.grossCents');
  const refundedCents = integer(source.refundedCents, 'order.refundedCents');
  if (source.currency !== 'USD') throw new Error('only USD is supported');
  if (refundedTickets > tickets) throw new Error('refunded tickets exceed sold tickets');
  if (refundedCents > grossCents) throw new Error('refunded amount exceeds gross amount');

  return {
    deliveryId,
    order: { id, showId, revision, tickets, refundedTickets, grossCents, refundedCents, currency: 'USD' },
  };
}
