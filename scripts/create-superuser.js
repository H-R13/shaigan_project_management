// Equivalent of `python manage.py createsuperuser`
//   npm run createsuperuser
//   npm run createsuperuser -- --username admin --email a@b.com --password secret

require("dotenv").config({ quiet: true });
const readline = require("readline");
const { sequelize, User, Group } = require("../src/models");
const { hashPassword } = require("../src/lib/password");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.includes(question)) rl.output.write(s);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

async function main() {
  await sequelize.authenticate();

  let username = arg("username");
  while (!username) username = await ask("Username: ");
  if (await User.findOne({ where: { username } })) {
    throw new Error(`A user named "${username}" already exists.`);
  }

  const email = arg("email") ?? (await ask("Email address (optional): "));

  let password = arg("password");
  while (!password) {
    const p1 = await ask("Password: ", { hidden: true });
    const p2 = await ask("Password (again): ", { hidden: true });
    if (p1 !== p2) console.log("Passwords do not match. Try again.");
    else if (p1.length < 8) console.log("Use at least 8 characters.");
    else password = p1;
  }

  const user = await User.create({
    username,
    email: email || "",
    password: await hashPassword(password),
    is_superuser: true,
    is_active: true,
  });

  const adminGroup = await Group.findOne({ where: { name: "Administrator" } });
  if (adminGroup) await user.addGroup(adminGroup);

  console.log(`Superuser "${username}" created.`);
  await sequelize.close();
}

main().catch(async (err) => {
  console.error("Error:", err.message);
  await sequelize.close().catch(() => {});
  process.exit(1);
});
