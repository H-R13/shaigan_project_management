require("dotenv").config({ quiet: true });
const app = require("./app");
const { sequelize } = require("./models");

const PORT = Number(process.env.PORT) || 3000;

(async () => {
  try {
    await sequelize.authenticate();
    // Create the sessions table if it does not exist yet
    await app.locals.sessionStore.sync();
    app.listen(PORT, () => {
      console.log(`Shaigan Project Management running at http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("Could not connect to the database:", err.message);
    console.error("Check the DB_* settings in your .env file and run `npm run db:init` first.");
    process.exit(1);
  }
})();
