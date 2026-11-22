// Generates the private admin values for your .env file.
// Run:  npm run setup-admin
// Nothing is sent anywhere; values are only printed in your terminal.
const crypto = require('crypto');
const readline = require('readline');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.stdoutMuted = true;
    rl._writeToOutput = function (s) { rl.output.write(rl.stdoutMuted ? (s.includes(question) ? s : '*') : s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}
function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
  });
}

(async () => {
  const email = await ask('Admin email (your own): ');
  let pass = await askHidden('Choose an admin password (12+ characters): ');
  while (pass.length < 12) pass = await askHidden('Too short. Admin password (12+ characters): ');
  const again = await askHidden('Type it again: ');
  if (again !== pass) { console.error('Passwords did not match. Run the script again.'); process.exit(1); }
  const use2fa = (await ask('Turn on 2-step codes with an authenticator app? (Y/n): ')).toLowerCase() !== 'n';

  const hash = bcrypt.hashSync(pass, 12);
  const adminPath = '/admin-' + crypto.randomBytes(18).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 24);
  const totp = use2fa ? authenticator.generateSecret() : '';

  console.log('\n--- Copy these lines into your .env file (and into your host\'s secret settings) ---\n');
  console.log(`ADMIN_EMAIL=${email}`);
  console.log(`ADMIN_PASSWORD_HASH='${hash}'`);
  console.log(`ADMIN_PATH=${adminPath}`);
  if (totp) console.log(`ADMIN_TOTP_SECRET=${totp}`);
  console.log('\n-------------------------------------------------------------------------------');
  console.log(`Your private admin link will be:  https://<your-domain>${adminPath}`);
  if (totp) {
    console.log('\n2-step setup: in Google Authenticator / Authy, choose "Enter a setup key" and type:');
    console.log(`  Account: MolBhav admin   Key: ${totp}   Type: Time-based`);
    console.log('Or open this link on your phone:');
    console.log(`  ${authenticator.keyuri(email, 'MolBhav', totp)}`);
  }
  console.log('\nKeep these values secret. Never commit .env to GitHub.\n');
})();
