/**
 * Switches the beads-ui board server to one project, so a Bead opened from a link is found
 * whatever project the board showed before (fac-qpv.7.2).
 *
 * The board takes its own page's websocket messages at ws://127.0.0.1:<port>/ws, and a
 * `set-workspace` message naming a path moves the board's database, its watchers and every
 * open board page to that project. The board answers on the same socket, and this exits 1
 * when it does not answer within a few seconds, so a click carries on without it.
 *
 * A project with no .beads folder has no database to switch to, so it is refused with exit
 * 2 and a message before the board is asked, leaving the board where it was.
 *
 *   node board.mjs <port> <project path>
 */
import { statSync } from "node:fs";
import { join } from "node:path";

const [port, project] = process.argv.slice(2);

let hasDatabase = false;
try {
	hasDatabase = statSync(join(project, ".beads")).isDirectory();
} catch {
	// A path that is not there, or not a folder, holds no database either.
}
if (!hasDatabase) {
	console.error(`click-open: ${project} has no .beads folder, so the board is not switched there`);
	process.exit(2);
}

const id = "click-open";
const timeout = 3000;

const answer = await new Promise((resolve) => {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	const timer = setTimeout(() => {
		socket.close();
		resolve(null);
	}, timeout);
	socket.addEventListener("open", () => {
		socket.send(JSON.stringify({ id, type: "set-workspace", payload: { path: project } }));
	});
	socket.addEventListener("message", (event) => {
		let message;
		try {
			message = JSON.parse(String(event.data));
		} catch {
			return;
		}
		if (message.id !== id) return;
		clearTimeout(timer);
		socket.close();
		resolve(message);
	});
	socket.addEventListener("error", () => {
		clearTimeout(timer);
		resolve(null);
	});
});

if (!answer) {
	console.error(`click-open: no answer from the board on port ${port}`);
	process.exit(1);
}
if (!answer.ok) {
	console.error(`click-open: the board refused the project: ${JSON.stringify(answer.error ?? {})}`);
	process.exit(1);
}
