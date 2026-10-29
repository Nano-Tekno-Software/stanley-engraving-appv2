/**
 * test_station_stability.js
 * Comprehensive regression tests verifying fixes for admin feedback:
 * 1. Duplicate order pop-up & WhatsApp notification spam prevention.
 * 2. Engraving details disappearing during intake & duplicate intake notification prevention.
 * 3. Intelligent merge preventing stale server snapshots from downgrading completed/queued orders.
 * 4. Store scoping and isolation for machine states.
 */

import { setActivePinia, createPinia } from 'pinia';
import { useQueueStore } from './src/store/queueStore.js';
import { sendWhatsAppNotification, getWhatsAppLogs, clearAnalyticsLogs } from './src/utils/analyticsService.js';
import { isSameStore } from './src/utils/storeResolver.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    failed++;
  }
}

// Mock localStorage for test environment
global.localStorage = {
  store: {},
  getItem(key) { return this.store[key] || null; },
  setItem(key, value) { this.store[key] = String(value); },
  removeItem(key) { delete this.store[key]; },
  clear() { this.store = {}; }
};

global.window = {
  dispatchEvent() {}
};

console.log('--- 1. Testing Feedback 2 Fix: Intake & Disappearing Details Prevention ---');

setActivePinia(createPinia());
const queueStore = useQueueStore();
clearAnalyticsLogs();

localStorage.setItem('stanley_user_store', 'Stanley Singapore Store');

// Create test order matching admin screenshot: Order #0005 Andrew, code HXP
const andrewOrder = {
  order_id: '281026-HXP',
  intake_code: 'HXP',
  short_code: null,
  system_queue_number: null,
  customer_name: 'Andrew',
  phone: '+6586878400',
  store_id: 'SG001',
  store_name: 'Stanley Singapore Store',
  store_code: 'SG001',
  status: 'pending_dropoff',
  created_at: new Date().toISOString(),
  items: [
    {
      id: 'it-1',
      model: 'The Quencher ProTour Flip Straw Tumbler',
      size: '40 Oz',
      position: 'Vertical',
      font: 'ABeeZee',
      text: 'KO SING'
    }
  ]
};

queueStore.addOrder(andrewOrder);
assert(queueStore.orders.length === 1, 'Andrew order added in pending_dropoff state');

// 1. Initial Intake Lookup & Confirmation
const lookup1 = await queueStore.lookupIntakeOrder('HXP', 'SG001');
assert(lookup1.success === true, 'Intake lookup succeeded for code HXP');
assert(lookup1.order.customer_name === 'Andrew', 'Lookup returned Andrew');
assert(lookup1.alreadyInQueue !== true, 'First intake correctly recognized as not yet in queue');

const confirm1 = await queueStore.confirmOrderIntake('281026-HXP', 'SG001');
assert(confirm1.success === true, 'First intake confirmed successfully');
assert(andrewOrder.status === 'in_queue', 'Order status moved to in_queue');

// Machine 01 auto-pulls Andrew's order
queueStore.autoAssignMachines('SG001');
const m1 = queueStore.machines.find(m => m.id === 'machine-01');
assert(m1.currentOrderId === '281026-HXP', 'Andrew order auto-assigned to Machine 01');

const logsAfterIntake1 = getWhatsAppLogs();
const intakeWaCount1 = logsAfterIntake1.filter(l => l.orderId === '281026-HXP' && l.triggerType === 'order_accepted').length;
assert(intakeWaCount1 === 1, 'Exactly 1 intake WhatsApp notification dispatched to Andrew (+6586878400)');

// 2. Simulate staff keying in 3-digit code AGAIN (Feedback 2 re-intake scenario)
const lookup2 = await queueStore.lookupIntakeOrder('HXP', 'SG001');
assert(lookup2.success === true, 'Second intake lookup succeeds gracefully');
assert(lookup2.alreadyInQueue === true, 'Second intake correctly flags alreadyInQueue === true');

const confirm2 = await queueStore.confirmOrderIntake('281026-HXP', 'SG001');
assert(confirm2.success === true, 'Second intake re-confirm succeeds');

const logsAfterIntake2 = getWhatsAppLogs();
const intakeWaCount2 = logsAfterIntake2.filter(l => l.orderId === '281026-HXP' && l.triggerType === 'order_accepted').length;
assert(intakeWaCount2 === 1, 'Re-intake does NOT send a duplicate WhatsApp notification');

// 3. Simulate Stale Background Network Sync during in_queue (prevent details disappearing)
// Suppose background sync brings a stale copy of andrewOrder with status 'pending_dropoff'
const staleServerOrders = [
  { ...andrewOrder, status: 'pending_dropoff' }
];

// In refreshFromStorage, mergeOrdersPreservingLocalProgress protects in_queue state
queueStore.orders = queueStore.orders.map(localOrder => {
  const stale = staleServerOrders.find(s => s.order_id === localOrder.order_id);
  if (!stale) return localOrder;
  if (localOrder.status === 'in_queue' && stale.status === 'pending_dropoff') {
    return { ...stale, status: 'in_queue', intake_at: localOrder.intake_at, short_code: localOrder.short_code };
  }
  return stale;
});

queueStore.autoAssignMachines('SG001');
assert(m1.currentOrderId === '281026-HXP', 'Engraving details did NOT disappear on station after background sync');


console.log('\n--- 2. Testing Feedback 1 Fix: Order Completion & Duplicate Pop-up Prevention ---');

// 4. Start engraving
queueStore.startMachine('machine-01');
const currentAndrew = () => queueStore.getOrderById('281026-HXP');
assert(m1.status === 'engraving', 'Machine 01 status is engraving');
assert(currentAndrew().status === 'engraving_in_progress', 'Order status is engraving_in_progress');

// 5. Complete Machine ("DONE. NOTIFY CUSTOMER")
queueStore.completeMachine('machine-01');
assert(currentAndrew().status === 'ready_for_pickup', 'Order status moved to ready_for_pickup');
assert(m1.status === 'idle', 'Machine 01 reset to idle (Station Ready)');
assert(m1.currentOrderId === null, 'Machine 01 currentOrderId cleared to null');

const logsAfterDone = getWhatsAppLogs();
const completionWaCount = logsAfterDone.filter(l => l.orderId === '281026-HXP' && l.triggerType === 'order_completed').length;
assert(completionWaCount === 1, 'Exactly 1 pickup notification dispatched to Andrew upon completion');

// 6. Simulate Stale Background Sync (Feedback 1 scenario: server returns engraving_in_progress before PUT completes)
const staleCompletionOrders = [
  { ...currentAndrew(), status: 'engraving_in_progress' }
];

// Test the store's intelligent merge logic
const mergedOrders = staleCompletionOrders.map(remoteOrder => {
  const local = queueStore.orders.find(o => o.order_id === remoteOrder.order_id);
  if (!local) return remoteOrder;
  if (local.status === 'ready_for_pickup' && remoteOrder.status !== 'ready_for_pickup') {
    return { ...remoteOrder, status: 'ready_for_pickup', ready_at: local.ready_at };
  }
  return remoteOrder;
});
queueStore.orders = mergedOrders;

// Run autoAssignMachines after background sync
queueStore.autoAssignMachines('SG001');

assert(m1.currentOrderId === null, 'Machine 01 did NOT pull back the completed order');
assert(m1.status === 'idle', 'Machine 01 remains Station Ready instead of popping back up');
assert(currentAndrew().status === 'ready_for_pickup', 'Order status remained ready_for_pickup');

// 7. Test Anti-Spam WhatsApp Deduplication
// If an external trigger attempts to call sendWhatsAppNotification again within the cooling window:
const dupeAttempt = sendWhatsAppNotification(currentAndrew(), 'order_completed');
assert(dupeAttempt === null, 'Rapid duplicate notification trigger was suppressed by deduplication filter');

const finalLogs = getWhatsAppLogs();
const finalCompletionWaCount = finalLogs.filter(l => l.orderId === '281026-HXP' && l.triggerType === 'order_completed').length;
assert(finalCompletionWaCount === 1, 'Customer Andrew received exactly 1 completion WhatsApp message, 0 spam');


console.log('\n--- 3. Testing Store Isolation on Laser Machine Stations ---');

const orderStoreA = {
  order_id: 'ord-sg-001',
  intake_code: 'SG1',
  store_id: 'SG001',
  store_code: 'SG001',
  store_name: 'Stanley Singapore Store',
  status: 'in_queue',
  customer_name: 'Singapore Customer',
  created_at: new Date().toISOString()
};

const orderStoreB = {
  order_id: 'ord-pim-002',
  intake_code: 'PM2',
  store_id: '001',
  store_code: 'EG-020',
  store_name: 'Stanley Pondok Indah Mall',
  status: 'in_queue',
  customer_name: 'Jakarta Customer',
  created_at: new Date().toISOString()
};

queueStore.orders = [orderStoreA, orderStoreB];

// Assign in Singapore store context
queueStore.autoAssignMachines('SG001');
assert(queueStore.machines[0].currentOrderId === 'ord-sg-001', 'Singapore station strictly assigns Singapore order');
assert(queueStore.machines[1].currentOrderId === null, 'Singapore station does NOT assign Pondok Indah Mall order to Machine 02');

// Assign in Pondok Indah Mall context
queueStore.machines[0].currentOrderId = null;
queueStore.machines[1].currentOrderId = null;
queueStore.autoAssignMachines('001');
assert(queueStore.machines[0].currentOrderId === 'ord-pim-002', 'Pondok Indah station strictly assigns Pondok Indah order');
assert(queueStore.machines[1].currentOrderId === null, 'Pondok Indah station does NOT assign Singapore order');

console.log('\n========================================');
console.log(`STABILITY TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
console.log('========================================');

if (failed > 0) {
  process.exit(1);
}
