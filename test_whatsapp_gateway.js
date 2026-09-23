import assert from 'assert';

console.log('\n--- Running Zero-Cost WhatsApp Gateway End-to-End Tests ---');

async function runTests() {
  const BASE_URL = 'http://localhost:3000';

  // 1. Initial status for Stanley Singapore Store (SG001)
  const res1 = await fetch(`${BASE_URL}/api/whatsapp/SG001/status`);
  assert(res1.ok, 'GET /api/whatsapp/SG001/status returns 200');
  const status1 = await res1.json();
  console.log('1. Initial status SG001:', status1.status);
  assert(status1.storeId === 'SG001', 'Store ID is SG001');
  assert(typeof status1.connected === 'boolean', 'Connected flag is boolean');
  console.log('✓ Initial store WhatsApp status retrieved successfully');

  // 2. Multi-store isolation check for Puri Indah Mall (004)
  const resPuri = await fetch(`${BASE_URL}/api/whatsapp/004/status`);
  assert(resPuri.ok, 'GET /api/whatsapp/004/status returns 200');
  const statusPuri = await resPuri.json();
  console.log('2. Multi-store isolation check (004):', statusPuri.storeId);
  assert(statusPuri.storeId === '004', 'Store ID is 004');
  console.log('✓ Multi-store session isolation confirmed');

  // 3. Initiate WhatsApp Connection for SG001 (Generates QR code)
  console.log('3. Triggering WhatsApp connection for SG001...');
  const resConnect = await fetch(`${BASE_URL}/api/whatsapp/SG001/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });
  assert(resConnect.ok, 'POST /api/whatsapp/SG001/connect returns 200');
  const connectData = await resConnect.json();
  assert(connectData.success === true, 'Connect call succeeded');
  console.log('✓ Connect endpoint triggered successfully');

  // 4. Poll for generated QR code data URL
  console.log('4. Waiting for Baileys QR code generation...');
  let qrReady = false;
  let qrData = null;
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1200));
    const checkRes = await fetch(`${BASE_URL}/api/whatsapp/SG001/status`);
    if (checkRes.ok) {
      const data = await checkRes.json();
      if (data.status === 'qr_ready' && data.qr) {
        qrReady = true;
        qrData = data.qr;
        break;
      }
    }
  }

  assert(qrReady, 'QR code was generated within expected window');
  assert(qrData.startsWith('data:image/png;base64,'), 'QR is a valid PNG Data URL');
  console.log('✓ QR code successfully generated! Prefix:', qrData.substring(0, 40) + '...');

  // 5. Test send-test error handling when not yet paired
  console.log('5. Testing dispatch rejection when unlinked...');
  const resTest = await fetch(`${BASE_URL}/api/whatsapp/SG001/send-test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipientPhone: '+65 8123 4567',
      message: 'Test automated dispatch'
    })
  });
  const testData = await resTest.json();
  assert(!resTest.ok || !testData.success, 'Correctly blocks dispatch when device is not fully paired');
  console.log('✓ Unpaired dispatch safely guarded with error message:', testData.error);

  // 6. Test Disconnect & Unlink
  console.log('6. Testing session disconnect...');
  const resDisconnect = await fetch(`${BASE_URL}/api/whatsapp/SG001/disconnect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });
  assert(resDisconnect.ok, 'POST /api/whatsapp/SG001/disconnect returns 200');
  const disconnectData = await resDisconnect.json();
  assert(disconnectData.status === 'disconnected', 'Status is disconnected');

  const finalCheck = await (await fetch(`${BASE_URL}/api/whatsapp/SG001/status`)).json();
  assert(finalCheck.connected === false, 'Session is not connected after disconnect');
  assert(finalCheck.qr === null, 'QR code is cleared after disconnect');
  console.log('✓ Disconnect and unlinking validated successfully');

  console.log('\n========================================');
  console.log('ALL WHATSAPP GATEWAY TESTS PASSED (100%)');
  console.log('========================================\n');
}

runTests().catch(err => {
  console.error('WhatsApp Gateway test failed:', err);
  process.exit(1);
});
