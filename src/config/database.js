require("dotenv").config({ quiet: true });
const { Sequelize } = require("sequelize");

const dialect = process.env.DB_DIALECT || "mysql";

const options = {
  dialect,
  logging: process.env.DB_LOGGING === "true" ? console.log : false,
  define: {
    underscored: true, // column names like created_at, assigned_to_id
  },
};

if (dialect === "sqlite") {
  options.storage = process.env.DB_STORAGE || "./database/dev.sqlite3";
} else {
  options.host = process.env.DB_HOST || "127.0.0.1";
  if (process.env.DB_PORT) options.port = Number(process.env.DB_PORT);

  if (dialect === "mssql") {
    options.dialectOptions = {
      options: { encrypt: false, trustServerCertificate: true },
    };
  } else {
    // Same as Django TIME_ZONE = "Asia/Karachi"
    options.timezone = process.env.DB_TIMEZONE || "+05:00";
  }
}

const sequelize =
  dialect === "sqlite"
    ? new Sequelize(options)
    : new Sequelize(
        process.env.DB_NAME || "project_management",
        process.env.DB_USER || "root",
        process.env.DB_PASSWORD || "",
        options
      );

module.exports = sequelize;
