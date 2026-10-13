// Shaigan Projects — interactive bits (no framework).
//   * Status / assignee pickers save straight away
//   * Project board: drag cards between lists, quick-add a task
//   * Links marked data-popup open their form in a popup
//   * Toasts for feedback, mobile menu, card subtask toggles
// Everything is checked again on the server (Administration > Users & access).
(function () {
    "use strict";

    var csrf = (document.querySelector('meta[name="csrf-token"]') || {}).content || "";

    // ---------------------------------------------------------------
    // Toasts
    // ---------------------------------------------------------------
    var toastBox = document.getElementById("toasts");
    function dismiss(el, delay) {
        setTimeout(function () {
            el.classList.add("leaving");
            setTimeout(function () { el.remove(); }, 220);
        }, delay);
    }
    function toast(text, isError) {
        if (!toastBox) return;
        var el = document.createElement("div");
        el.className = "toast" + (isError ? " error" : "");
        el.textContent = text;
        toastBox.appendChild(el);
        dismiss(el, isError ? 6000 : 3000);
    }
    if (toastBox) {
        toastBox.querySelectorAll(".toast").forEach(function (el) {
            dismiss(el, el.classList.contains("error") ? 7000 : 4000);
        });
    }

    // ---------------------------------------------------------------
    // POST helper: form-encoded body, CSRF header, JSON answer
    // ---------------------------------------------------------------
    function post(url, data) {
        return fetch(url, {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/x-www-form-urlencoded", "X-CSRF-Token": csrf, "Accept": "application/json" },
            body: new URLSearchParams(data).toString()
        }).then(function (res) {
            return res.json().catch(function () {
                return { ok: false, error: res.status === 403 ? "You are not allowed to do that. Reload the page and try again." : "Something went wrong. Please try again." };
            });
        }, function () {
            return { ok: false, error: "Can't reach the server. Check your connection and try again." };
        });
    }

    // ---------------------------------------------------------------
    // Inline status picker
    // ---------------------------------------------------------------
    document.addEventListener("focusin", function (e) {
        var sel = e.target.closest && e.target.closest(".status-picker, .assign-picker");
        if (sel && sel.dataset.saved === undefined) sel.dataset.saved = sel.value;
    });

    document.addEventListener("change", function (e) {
        var sel = e.target;
        if (sel.matches(".status-picker")) saveStatus(sel);
        else if (sel.matches(".assign-picker")) saveAssignee(sel);
    });

    function saveStatus(sel) {
        var previous = sel.dataset.saved !== undefined ? sel.dataset.saved : sel.value;
        sel.classList.add("is-saving");
        post(sel.dataset.url, { status: sel.value }).then(function (r) {
            sel.classList.remove("is-saving");
            if (!r.ok) {
                sel.value = previous;
                toast(r.error, true);
                return;
            }
            sel.dataset.saved = r.status;
            sel.className = "status-picker " + r.className;
            markDone(sel, r.status);
            if (!r.editable) {
                // completed and now locked for this user: show a plain pill
                var pill = document.createElement("span");
                pill.className = r.className;
                pill.textContent = r.label;
                sel.replaceWith(pill);
            }
            toast("Status changed to " + r.label + ".");
        });
    }

    function markDone(el, status) {
        var holder = el.closest(".task-card, .item-card, .subtask-link, tr");
        if (holder) holder.classList.toggle("is-done", status === "completed");
    }

    function saveAssignee(sel) {
        var previous = sel.dataset.saved !== undefined ? sel.dataset.saved : sel.value;
        sel.classList.add("is-saving");
        post(sel.dataset.url, { assigned_to_id: sel.value }).then(function (r) {
            sel.classList.remove("is-saving");
            if (!r.ok) {
                sel.value = previous;
                toast(r.error, true);
                return;
            }
            sel.dataset.saved = sel.value;
            sel.classList.toggle("is-empty", !sel.value);
            toast(r.username ? "Assigned to " + r.username + "." : "Now unassigned.");
        });
    }

    // ---------------------------------------------------------------
    // Project board: drag & drop between lists
    // ---------------------------------------------------------------
    var board = document.querySelector("[data-board]");
    var dragged = null;
    var dragFrom = null;

    function updateCounts() {
        if (!board) return;
        board.querySelectorAll(".board-column[data-list-id]").forEach(function (col) {
            var n = col.querySelectorAll(".task-card").length;
            var count = col.querySelector("[data-count]");
            var empty = col.querySelector("[data-empty]");
            if (count) count.textContent = n;
            if (empty) empty.hidden = n > 0;
        });
    }

    if (board) {
        board.addEventListener("dragstart", function (e) {
            var card = e.target.closest && e.target.closest('.task-card[draggable="true"]');
            if (!card) return;
            dragged = card;
            dragFrom = card.closest(".board-column[data-list-id]");
            card.classList.add("dragging");
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", card.dataset.taskId);
        });
        board.addEventListener("dragend", function () {
            if (dragged) dragged.classList.remove("dragging");
            board.querySelectorAll(".drag-over").forEach(function (c) { c.classList.remove("drag-over"); });
        });
        board.addEventListener("dragover", function (e) {
            if (!dragged) return;
            var col = e.target.closest(".board-column[data-list-id]");
            if (!col) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            board.querySelectorAll(".drag-over").forEach(function (c) { if (c !== col) c.classList.remove("drag-over"); });
            col.classList.add("drag-over");
        });
        board.addEventListener("drop", function (e) {
            var col = e.target.closest(".board-column[data-list-id]");
            if (!dragged || !col) return;
            e.preventDefault();
            col.classList.remove("drag-over");
            var card = dragged;
            var from = dragFrom;
            dragged = null;
            if (col === from) return;
            var body = col.querySelector("[data-column-body]");
            body.insertBefore(card, body.querySelector("[data-empty]"));
            updateCounts();
            post(card.dataset.moveUrl, { project_list_id: col.dataset.listId }).then(function (r) {
                if (!r.ok) {
                    var back = from.querySelector("[data-column-body]");
                    back.insertBefore(card, back.querySelector("[data-empty]"));
                    updateCounts();
                    toast(r.error, true);
                    return;
                }
                toast("Moved to " + r.list + ".");
            });
        });

        // Keyboard alternative: focus a card's link and press Alt+Left / Alt+Right
        board.addEventListener("keydown", function (e) {
            if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
            var card = e.target.closest('.task-card[draggable="true"]');
            if (!card) return;
            var cols = Array.prototype.slice.call(board.querySelectorAll(".board-column[data-list-id]"));
            var from = card.closest(".board-column[data-list-id]");
            var to = cols[cols.indexOf(from) + (e.key === "ArrowRight" ? 1 : -1)];
            if (!to) return;
            e.preventDefault();
            dragged = card; dragFrom = from;
            var drop = new Event("drop", { bubbles: true });
            drop.preventDefault = function () {};
            to.querySelector("[data-column-body]").dispatchEvent(drop);
            var link = card.querySelector("a");
            if (link) link.focus();
        });
    }

    // ---------------------------------------------------------------
    // Project board: quick add
    // ---------------------------------------------------------------
    function esc(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }
    document.querySelectorAll("[data-quick-add]").forEach(function (box) {
        var toggle = box.querySelector(".quick-add-toggle");
        var form = box.querySelector("form");
        var input = form.querySelector("textarea");
        function open() { box.classList.add("open"); input.focus(); }
        function close() { box.classList.remove("open"); input.value = ""; toggle.focus(); }
        toggle.addEventListener("click", open);
        box.querySelector("[data-quick-cancel]").addEventListener("click", close);
        input.addEventListener("keydown", function (e) {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
            if (e.key === "Escape") close();
        });
        form.addEventListener("submit", function (e) {
            e.preventDefault();
            var title = input.value.trim();
            if (!title) { input.focus(); return; }
            input.disabled = true;
            post(box.dataset.url, { title: title }).then(function (r) {
                input.disabled = false;
                if (!r.ok) { toast(r.error, true); input.focus(); return; }
                var card = document.createElement("article");
                card.className = "task-card";
                card.dataset.taskId = r.id;
                if (r.canMove) { card.draggable = true; card.dataset.moveUrl = "/api/task/" + r.id + "/move"; }
                card.innerHTML =
                    '<div class="task-title"><a href="' + esc(r.url) + '" class="card-link">' + esc(r.title) + "</a></div>" +
                    '<div class="task-footer"><span class="badge status-' + esc(r.status) + '">' + esc(r.statusLabel) + "</span>" +
                    '<span class="badge priority-' + esc(r.priority) + '">' + esc(r.priorityLabel) + "</span></div>";
                var body = box.closest(".board-column[data-list-id]").querySelector("[data-column-body]");
                body.insertBefore(card, body.querySelector("[data-empty]"));
                updateCounts();
                input.value = "";
                input.focus();
                toast("Task added.");
            });
        });
    });

    // Users & access: colour the "Can see" choice as it changes
    document.addEventListener("change", function (e) {
        var sel = e.target.closest && e.target.closest(".see-select");
        if (sel) sel.className = "see-select see-" + (sel.value || sel.dataset.roleSee + " see-inherit");
    });

    // ---------------------------------------------------------------
    // Project board: add, rename and delete lists
    // ---------------------------------------------------------------
    document.querySelectorAll("[data-add-list]").forEach(function (form) {
        var input = form.querySelector("input");
        form.addEventListener("submit", function (e) {
            e.preventDefault();
            var name = input.value.trim();
            if (!name) { input.focus(); return; }
            input.disabled = true;
            post(form.dataset.addList, { name: name }).then(function (r) {
                input.disabled = false;
                if (!r.ok) { toast(r.error, true); input.focus(); return; }
                window.location.reload();
            });
        });
    });
    document.addEventListener("click", function (e) {
        var rename = e.target.closest && e.target.closest("[data-list-rename]");
        var del = e.target.closest && e.target.closest("[data-list-delete]");
        if (rename) {
            var title = rename.closest(".board-column").querySelector("[data-list-name]");
            var name = window.prompt("New name for this list:", title.textContent.trim());
            if (name === null || !name.trim() || name.trim() === title.textContent.trim()) return;
            post(rename.dataset.listRename, { name: name.trim() }).then(function (r) {
                if (!r.ok) { toast(r.error, true); return; }
                title.textContent = r.name;
                toast("List renamed.");
            });
        } else if (del) {
            var col = del.closest(".board-column");
            var listName = col.querySelector("[data-list-name]").textContent.trim();
            if (!window.confirm('Delete the list "' + listName + '"?')) return;
            post(del.dataset.listDelete, {}).then(function (r) {
                if (!r.ok) { toast(r.error, true); return; }
                col.remove();
                toast("List deleted.");
            });
        }
    });

    // ---------------------------------------------------------------
    // Popups: links with data-popup load the page's form into a dialog
    // ---------------------------------------------------------------
    var dialog = document.getElementById("popup");
    var popupTitle = document.getElementById("popup-title");
    var popupBody = document.getElementById("popup-body");
    var opener = null;

    function closePopup() {
        if (dialog && dialog.open) dialog.close();
    }

    if (dialog && typeof dialog.showModal === "function") {
        document.addEventListener("click", function (e) {
            var link = e.target.closest("a[data-popup]");
            if (!link || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            opener = link;
            popupTitle.textContent = link.textContent.trim() || "Loading";
            popupBody.innerHTML = '<div class="popup-loading">Loading…</div>';
            dialog.showModal();
            fetch(link.href, { credentials: "same-origin", headers: { Accept: "text/html" } })
                .then(function (res) { return res.text().then(function (html) { return { ok: res.ok, html: html }; }); })
                .then(function (r) {
                    var doc = new DOMParser().parseFromString(r.html, "text/html");
                    var body = doc.querySelector("[data-popup-body]");
                    if (!r.ok || !body) {
                        // not a popup page (or an error page): just go there
                        window.location.href = link.href;
                        return;
                    }
                    var title = doc.querySelector("[data-popup-title]");
                    popupTitle.textContent = title ? title.textContent.trim() : "";
                    popupBody.innerHTML = "";
                    popupBody.appendChild(document.importNode(body, true));
                    var first = popupBody.querySelector("input:not([type=hidden]):not([readonly]), select, textarea, button");
                    if (first) first.focus();
                })
                .catch(function () { window.location.href = link.href; });
        });

        dialog.addEventListener("click", function (e) {
            if (e.target === dialog) closePopup(); // click on the backdrop
            var closer = e.target.closest("[data-popup-close]");
            if (closer) { e.preventDefault(); closePopup(); }
        });
        dialog.addEventListener("close", function () {
            popupBody.innerHTML = "";
            if (opener) opener.focus();
        });
    }

    // ---------------------------------------------------------------
    // Dashboard cards: show / hide subtasks
    // ---------------------------------------------------------------
    document.addEventListener("click", function (e) {
        var btn = e.target.closest(".subtask-toggle");
        if (!btn) return;
        var list = document.getElementById(btn.getAttribute("aria-controls"));
        var open = btn.getAttribute("aria-expanded") === "true";
        btn.setAttribute("aria-expanded", String(!open));
        btn.title = open ? "Show subtasks" : "Hide subtasks";
        if (list) list.hidden = open;
    });

    // ---------------------------------------------------------------
    // Mobile menu + top bar shadow on scroll
    // ---------------------------------------------------------------
    var navBtn = document.querySelector("[data-nav-toggle]");
    if (navBtn) {
        navBtn.addEventListener("click", function () {
            var open = document.body.classList.toggle("nav-open");
            navBtn.setAttribute("aria-expanded", String(open));
        });
        document.querySelectorAll("[data-nav-close]").forEach(function (el) {
            el.addEventListener("click", function () {
                document.body.classList.remove("nav-open");
                navBtn.setAttribute("aria-expanded", "false");
            });
        });
    }
    var topbar = document.querySelector(".topbar");
    if (topbar) {
        var onScroll = function () { topbar.classList.toggle("scrolled", window.scrollY > 4); };
        window.addEventListener("scroll", onScroll, { passive: true });
        onScroll();
    }
})();
