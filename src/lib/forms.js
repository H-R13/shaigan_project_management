// A small replacement for Django ModelForms.
//
// A form is an array of field specs:
//   { name, label, type, required, maxLength, choices, min, help, readonly }
// type: text | textarea | date | number | select | fk | checkbox
//       | multiselect | password
// For select/fk/multiselect, `choices` is an array of [value, label].
//
// cleanForm(fields, body) -> { data, errors, values }
//   data   : cleaned values ready for Sequelize
//   errors : { fieldName: "message" }  (+ "__all__" for form-level errors)
//   values : raw submitted values, for re-displaying the form

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(str) {
  if (!DATE_RE.test(str)) return false;
  const d = new Date(`${str}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === str;
}

function asArray(v) {
  if (v === undefined || v === null || v === "") return [];
  return Array.isArray(v) ? v : [v];
}

function cleanForm(fields, body = {}) {
  const data = {};
  const errors = {};
  const values = {};

  for (const f of fields) {
    // Read-only fields are shown but never taken from the submitted form
    if (f.readonly) continue;

    const raw = body[f.name];

    switch (f.type) {
      case "checkbox": {
        const on = raw === "on" || raw === "true" || raw === "1" || (Array.isArray(raw) && raw.includes("on"));
        values[f.name] = on;
        data[f.name] = on;
        break;
      }

      case "multiselect": {
        const arr = asArray(raw).map(String);
        values[f.name] = arr;
        const allowed = new Set((f.choices || []).map(([v]) => String(v)));
        const bad = arr.filter((v) => !allowed.has(v));
        if (bad.length) errors[f.name] = "Select a valid choice.";
        else if (f.required && arr.length === 0) errors[f.name] = "This field is required.";
        data[f.name] = arr;
        break;
      }

      default: {
        const str = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
        // Like Django, strip surrounding whitespace (but not for passwords)
        const val = f.type === "password" ? str : str.trim();
        values[f.name] = val;

        if (val === "") {
          if (f.required) errors[f.name] = "This field is required.";
          if (f.type === "text" || f.type === "textarea") data[f.name] = "";
          else data[f.name] = null;
          break;
        }

        if (f.maxLength && val.length > f.maxLength) {
          errors[f.name] = `Ensure this value has at most ${f.maxLength} characters (it has ${val.length}).`;
          break;
        }

        if (f.type === "date") {
          if (!isValidDate(val)) errors[f.name] = "Enter a valid date.";
          else data[f.name] = val;
        } else if (f.type === "number") {
          const n = Number(val);
          if (!Number.isInteger(n)) errors[f.name] = "Enter a whole number.";
          else if (f.min !== undefined && n < f.min) errors[f.name] = `Ensure this value is greater than or equal to ${f.min}.`;
          else data[f.name] = n;
        } else if (f.type === "select" || f.type === "fk") {
          const ok = (f.choices || []).some(([v]) => String(v) === val);
          if (!ok) errors[f.name] = "Select a valid choice. That choice is not one of the available choices.";
          else data[f.name] = f.type === "fk" ? Number(val) : val;
        } else {
          data[f.name] = val;
        }
      }
    }
  }

  return { data, errors, values };
}

// Values for displaying a form bound to an existing instance
function initialValues(fields, instance = {}) {
  const values = {};
  for (const f of fields) {
    let v = instance[f.name];
    if (f.type === "checkbox") v = !!v;
    else if (f.type === "multiselect") v = (v || []).map(String);
    else if (v === null || v === undefined) v = "";
    else v = String(v);
    values[f.name] = v;
  }
  return values;
}

const hasErrors = (errors) => Object.keys(errors).length > 0;

module.exports = { cleanForm, initialValues, hasErrors };