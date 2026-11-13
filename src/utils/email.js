// Sends email over SMTP (any provider: Resend, Brevo, Gmail app password...).
// Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and MAIL_FROM. When they are
// not set, email is simply switched off and callers fall back to other channels.
let transporter = null;

const enabled = () => !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.MAIL_FROM);

function getTransporter() {
  if (!transporter) {
    const nodemailer = require('nodemailer');
    const port = Number(process.env.SMTP_PORT || 465);
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
  }
  return transporter;
}

/** Resolves true when the mail was handed to the SMTP server; never throws. */
async function sendEmail({ to, subject, text }) {
  if (!enabled()) return false;
  try {
    await getTransporter().sendMail({ from: process.env.MAIL_FROM, to, subject, text });
    return true;
  } catch (e) {
    console.error('Email send failed:', e.message);
    return false;
  }
}

module.exports = { enabled, sendEmail };
