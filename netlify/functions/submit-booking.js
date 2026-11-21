// Netlify Function: submit-booking.js
// Fires when a customer submits the BBT booking form or estimate request.
// 1. Creates customer + job in Housecall Pro
// 2. Sends confirmation email via Brevo
// 3. Schedules follow-up text via Quo (next day 10am CST)
// 4. Schedules follow-up email via Brevo (next day 10am CST)

const HCP_API_KEY    = process.env.HCP_API_KEY;
const BREVO_API_KEY  = process.env.BREVO_API_KEY;
const QUO_API_KEY    = process.env.QUO_API_KEY;
const QUO_INBOX      = '+14055959589'; // BBM OKC
const BBM_EMAIL      = 'moveme@biggerbettermovers.com';
const BBM_NAME       = 'Bigger Better Movers';

// ── Helpers ──────────────────────────────────────────────────────────────────

function next10amCST() {
  // Returns ISO string for next calendar day at 10:00 AM Central (UTC-6)
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setUTCHours(16, 0, 0, 0); // 10am CST = 16:00 UTC
  return tomorrow.toISOString();
}

async function postJSON(url, body, headers) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, ok: res.ok, json };
}

// ── HCP: create customer + job ────────────────────────────────────────────────

async function createHCPJob(data) {
  const headers = { Authorization: `Token ${HCP_API_KEY}` };

  // 1. Create or find customer
  const custRes = await postJSON(
    'https://api.housecallpro.com/customers',
    {
      first_name: data.fname,
      last_name:  data.lname,
      email:      data.email,
      mobile_number: data.phone,
      notifications_enabled: true,
    },
    headers
  );

  const customerId = custRes.json?.id;
  if (!customerId) {
    console.error('HCP customer create failed:', JSON.stringify(custRes.json));
    return null;
  }

  // 2. Create job
  const jobDesc = [
    `Service: ${data.serviceLabel || 'Moving'}`,
    `Move Size: ${data.moveScope || ''}`,
    `Packing: ${data.packing || 'No'}`,
    `Overnight Storage: ${data.overnight || 'No'}`,
    `Pickup: ${data.pickupAddr}, ${data.pickupCity}, ${data.pickupState} ${data.zipFrom}`,
    `Drop-off: ${data.dropAddr || 'TBD'}, ${data.dropCity || ''}, ${data.dropState || ''} ${data.zipTo}`,
    `Route: ${data.zipFrom} → ${data.zipTo}`,
    `Estimated Total: $${data.grandTotal || 'TBD'}`,
    `Mileage Fee: $${data.mileageFee || '0'}`,
    `Special Items: ${data.specialItems || 'None'}`,
    `Preferred Date: ${data.prefDate || 'TBD'}`,
    `Backup Date: ${data.backupDate || 'TBD'}`,
    `Submitted via: Better Budget Tool (biggerbettermovers.com)`,
  ].filter(Boolean).join('\n');

  const jobPayload = {
    customer_id: customerId,
    address: {
      street: data.pickupAddr || '',
      city:   data.pickupCity || '',
      state:  data.pickupState || 'OK',
      zip:    data.zipFrom || '',
    },
    note:         jobDesc,
    job_type:     data.formType === 'book' ? 'job' : 'estimate',
    lead_source:  'Website – Better Budget Tool',
    tags:         [data.formType === 'book' ? 'Online Booking' : 'Online Estimate'],
    schedule: data.prefDate ? {
      scheduled_start: new Date(data.prefDate + 'T08:00:00').toISOString(),
      scheduled_end:   new Date(data.prefDate + 'T12:00:00').toISOString(),
      arrival_window:  240,
    } : undefined,
  };

  const jobRes = await postJSON(
    'https://api.housecallpro.com/jobs',
    jobPayload,
    headers
  );

  if (!jobRes.ok) {
    console.error('HCP job create failed:', JSON.stringify(jobRes.json));
    return null;
  }

  return jobRes.json?.id;
}

// ── Brevo: send transactional email ──────────────────────────────────────────

async function sendBrevoEmail({ toEmail, toName, subject, htmlContent, scheduledAt }) {
  const body = {
    sender:  { name: BBM_NAME, email: BBM_EMAIL },
    to:      [{ email: toEmail, name: toName }],
    bcc:     [{ email: BBM_EMAIL, name: 'BBM Team' }],
    subject,
    htmlContent,
  };
  if (scheduledAt) body.scheduledAt = scheduledAt;

  return postJSON(
    'https://api.brevo.com/v3/smtp/email',
    body,
    { 'api-key': BREVO_API_KEY }
  );
}

// ── Quo: send SMS ─────────────────────────────────────────────────────────────

async function sendQuoSMS({ toPhone, message, scheduledAt }) {
  // Normalize phone to E.164
  const e164 = toPhone.replace(/\D/g, '');
  const phone = e164.startsWith('1') ? `+${e164}` : `+1${e164}`;

  const body = {
    inboxPhoneNumber:       QUO_INBOX,
    participantPhoneNumber: phone,
    body:                   message,
  };
  if (scheduledAt) body.scheduledAt = scheduledAt;

  return postJSON(
    'https://api.quoapp.com/v1/messages',
    body,
    { Authorization: `Bearer ${QUO_API_KEY}` }
  );
}

// ── Email templates ───────────────────────────────────────────────────────────

function estimateConfirmEmail(d) {
  return `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff">
  <div style="background:#cc1212;padding:24px;text-align:center">
    <h1 style="color:#fff;font-size:28px;margin:0;letter-spacing:2px">BIGGER BETTER MOVERS</h1>
    <p style="color:rgba(255,255,255,0.85);margin:4px 0 0;font-size:14px">Moving Made EASY!</p>
  </div>
  <div style="padding:32px 24px">
    <h2 style="color:#111;font-size:22px">Your Free Estimate, ${d.fname}!</h2>
    <p style="color:#444;line-height:1.6">Thanks for using our online quote tool. Here's a summary of your estimate:</p>
    <table style="width:100%;border-collapse:collapse;margin:20px 0">
      <tr style="background:#f7f7f7"><td style="padding:10px 12px;color:#666;font-size:13px">Service</td><td style="padding:10px 12px;font-weight:600;font-size:13px">${d.serviceLabel || 'Moving'}</td></tr>
      <tr><td style="padding:10px 12px;color:#666;font-size:13px">Route</td><td style="padding:10px 12px;font-weight:600;font-size:13px">${d.zipFrom} → ${d.zipTo}</td></tr>
      <tr style="background:#f7f7f7"><td style="padding:10px 12px;color:#666;font-size:13px">Preferred Date</td><td style="padding:10px 12px;font-weight:600;font-size:13px">${d.prefDate || 'TBD'}</td></tr>
      <tr><td style="padding:10px 12px;color:#666;font-size:13px;border-top:2px solid #cc1212">Estimated Total</td><td style="padding:10px 12px;font-weight:700;font-size:18px;color:#cc1212;border-top:2px solid #cc1212">$${d.grandTotal || 'See quote'}</td></tr>
    </table>
    <p style="color:#444;line-height:1.6">Our team will follow up with you shortly. If you have questions in the meantime, call or text us at <strong>(405) 595-9589</strong>.</p>
    <div style="text-align:center;margin:28px 0">
      <a href="tel:4055959589" style="background:#cc1212;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block">📞 Call Us Now</a>
    </div>
  </div>
  <div style="background:#111;padding:16px;text-align:center;color:rgba(255,255,255,0.5);font-size:12px">
    Bigger Better Movers · Oklahoma City &amp; Tulsa, OK · (405) 595-9589
  </div>
</div>`;
}

function estimateFollowUpEmail(d) {
  return `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff">
  <div style="background:#cc1212;padding:24px;text-align:center">
    <h1 style="color:#fff;font-size:28px;margin:0;letter-spacing:2px">BIGGER BETTER MOVERS</h1>
    <p style="color:rgba(255,255,255,0.85);margin:4px 0 0;font-size:14px">Moving Made EASY!</p>
  </div>
  <div style="padding:32px 24px">
    <h2 style="color:#111;font-size:22px">Hey ${d.fname}, still thinking it over?</h2>
    <p style="color:#444;line-height:1.6">Just wanted to follow up on the moving estimate you received yesterday. We know moving is a big deal — we'd love to answer any questions and make this as easy as possible for you.</p>
    <p style="color:#444;line-height:1.6">Your estimate was <strong style="color:#cc1212">$${d.grandTotal || 'on file'}</strong> for a move on <strong>${d.prefDate || 'your preferred date'}</strong>.</p>
    <p style="color:#444;line-height:1.6">Give us a call or reply to this email and we'll walk you through everything.</p>
    <div style="text-align:center;margin:28px 0">
      <a href="tel:4055959589" style="background:#cc1212;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block">📞 (405) 595-9589</a>
    </div>
    <p style="color:#888;font-size:13px">– Daniel White, Bigger Better Movers</p>
  </div>
  <div style="background:#111;padding:16px;text-align:center;color:rgba(255,255,255,0.5);font-size:12px">
    Bigger Better Movers · Oklahoma City &amp; Tulsa, OK · (405) 595-9589
  </div>
</div>`;
}

function bookingConfirmEmail(d) {
  return `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff">
  <div style="background:#cc1212;padding:24px;text-align:center">
    <h1 style="color:#fff;font-size:28px;margin:0;letter-spacing:2px">BIGGER BETTER MOVERS</h1>
    <p style="color:rgba(255,255,255,0.85);margin:4px 0 0;font-size:14px">Moving Made EASY!</p>
  </div>
  <div style="padding:32px 24px">
    <h2 style="color:#111;font-size:22px">🎉 You're on the schedule, ${d.fname}!</h2>
    <p style="color:#444;line-height:1.6">Your online booking has been received. Our team will call you within 24 hours to confirm all the details and walk through the scope of your move.</p>
    <table style="width:100%;border-collapse:collapse;margin:20px 0">
      <tr style="background:#f7f7f7"><td style="padding:10px 12px;color:#666;font-size:13px">Service</td><td style="padding:10px 12px;font-weight:600;font-size:13px">${d.serviceLabel || 'Moving'}</td></tr>
      <tr><td style="padding:10px 12px;color:#666;font-size:13px">Route</td><td style="padding:10px 12px;font-weight:600;font-size:13px">${d.zipFrom} → ${d.zipTo}</td></tr>
      <tr style="background:#f7f7f7"><td style="padding:10px 12px;color:#666;font-size:13px">Preferred Date</td><td style="padding:10px 12px;font-weight:600;font-size:13px">${d.prefDate || 'TBD'}</td></tr>
      <tr><td style="padding:10px 12px;color:#666;font-size:13px;border-top:2px solid #1f8a3c">Estimated Total</td><td style="padding:10px 12px;font-weight:700;font-size:18px;color:#1f8a3c;border-top:2px solid #1f8a3c">$${d.grandTotal || 'See quote'}</td></tr>
    </table>
    <p style="color:#444;line-height:1.6">Questions before we call? Reach us at <strong>(405) 595-9589</strong> anytime.</p>
    <div style="text-align:center;margin:28px 0">
      <a href="tel:4055959589" style="background:#1f8a3c;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block">📞 Call Us Now</a>
    </div>
  </div>
  <div style="background:#111;padding:16px;text-align:center;color:rgba(255,255,255,0.5);font-size:12px">
    Bigger Better Movers · Oklahoma City &amp; Tulsa, OK · (405) 595-9589
  </div>
</div>`;
}

function bookingFollowUpEmail(d) {
  return `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff">
  <div style="background:#cc1212;padding:24px;text-align:center">
    <h1 style="color:#fff;font-size:28px;margin:0;letter-spacing:2px">BIGGER BETTER MOVERS</h1>
    <p style="color:rgba(255,255,255,0.85);margin:4px 0 0;font-size:14px">Moving Made EASY!</p>
  </div>
  <div style="padding:32px 24px">
    <h2 style="color:#111;font-size:22px">Hey ${d.fname}, let's talk about your move!</h2>
    <p style="color:#444;line-height:1.6">You booked your move online yesterday — we just wanted to reach out and make sure we connect to review the full scope of work before moving day.</p>
    <p style="color:#444;line-height:1.6">A quick call helps us make sure we have the right crew size, truck count, and equipment for <strong>${d.prefDate || 'your move date'}</strong>. It only takes a few minutes and makes moving day go much smoother.</p>
    <div style="text-align:center;margin:28px 0">
      <a href="tel:4055959589" style="background:#cc1212;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block">📞 Call to Review Your Move</a>
    </div>
    <p style="color:#888;font-size:13px">– Daniel White, Bigger Better Movers</p>
  </div>
  <div style="background:#111;padding:16px;text-align:center;color:rgba(255,255,255,0.5);font-size:12px">
    Bigger Better Movers · Oklahoma City &amp; Tulsa, OK · (405) 595-9589
  </div>
</div>`;
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // CORS headers for the HTML page calling this function
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  let data;
  try {
    data = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: cors });
  }

  const isBook     = data.formType === 'book';
  const followUpAt = next10amCST();
  const results    = {};

  // 1. HCP job/estimate
  try {
    const hcpId = await createHCPJob(data);
    results.hcp = hcpId ? { ok: true, id: hcpId } : { ok: false };
  } catch (e) {
    results.hcp = { ok: false, error: e.message };
  }

  // 2. Instant confirmation email
  try {
    const emailRes = await sendBrevoEmail({
      toEmail:     data.email,
      toName:      `${data.fname} ${data.lname}`,
      subject:     isBook
        ? `Your BBM Booking Confirmation — ${data.prefDate || 'Move Scheduled'}`
        : `Your Free Moving Estimate from Bigger Better Movers`,
      htmlContent: isBook ? bookingConfirmEmail(data) : estimateConfirmEmail(data),
    });
    results.confirmEmail = { ok: emailRes.ok, status: emailRes.status };
  } catch (e) {
    results.confirmEmail = { ok: false, error: e.message };
  }

  // 3. Follow-up text next day at 10am CST
  try {
    const smsMsg = isBook
      ? `Hey ${data.fname}! It's the team at Bigger Better Movers. You booked your move online yesterday — we'd love to give you a quick call to review the scope of work before moving day. Give us a ring at (405) 595-9589 or just reply here! 🚛`
      : `Hey ${data.fname}! This is Bigger Better Movers — just following up on the moving estimate you received yesterday. Any questions? We'd love to earn your business! Call or text us at (405) 595-9589. 🚛`;

    const smsRes = await sendQuoSMS({
      toPhone:     data.phone,
      message:     smsMsg,
      scheduledAt: followUpAt,
    });
    results.followUpSMS = { ok: smsRes.ok, status: smsRes.status, scheduledAt: followUpAt };
  } catch (e) {
    results.followUpSMS = { ok: false, error: e.message };
  }

  // 4. Follow-up email next day at 10am CST
  try {
    const followRes = await sendBrevoEmail({
      toEmail:     data.email,
      toName:      `${data.fname} ${data.lname}`,
      subject:     isBook
        ? `Let's review your upcoming move, ${data.fname}!`
        : `Still thinking it over, ${data.fname}? We're here to help.`,
      htmlContent: isBook ? bookingFollowUpEmail(data) : estimateFollowUpEmail(data),
      scheduledAt: followUpAt,
    });
    results.followUpEmail = { ok: followRes.ok, status: followRes.status, scheduledAt: followUpAt };
  } catch (e) {
    results.followUpEmail = { ok: false, error: e.message };
  }

  return new Response(JSON.stringify({ success: true, results }), {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
};

export const config = { path: '/api/submit-booking' };
