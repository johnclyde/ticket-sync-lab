// Synthetic provider snapshots. No real customer or employer data.
export const order = {
  schemaVersion: 1, deliveryId: 'delivery-1',
  order: { id: 'order-a', showId: 'show-spring', revision: 1, tickets: 4, refundedTickets: 0, grossCents: 20000, refundedCents: 0, currency: 'USD' },
};
export const partialRefund = {
  schemaVersion: 2, deliveryId: 'delivery-2',
  order: { id: 'order-a', showId: 'show-spring', version: 2, quantities: { sold: 4, refunded: 1 }, amounts: { gross: 20000, refunded: 5000, currency: 'USD' } },
};
export const secondOrder = {
  schemaVersion: 2, deliveryId: 'delivery-3',
  order: { id: 'order-b', showId: 'show-spring', version: 1, quantities: { sold: 2, refunded: 0 }, amounts: { gross: 10000, refunded: 0, currency: 'USD' } },
};
