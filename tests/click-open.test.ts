/**
 * The click-open herdr plugin's board action (herdr-click-open-0h4): Ctrl-clicking a board
 * link splits the clicked pane to the right and opens the Bead's page in mdd (mddog), which
 * draws markdown as images with real fonts and heading sizes, the way GitHub draws it
 * (herdr-click-open-g2j). The page is markdown built from `bd show --json` in the link's
 * project, and mdd draws and scrolls it itself, so it is handed the page file alone: no pager
 * and no glow style. A Mac without mdd renders the same page with glow, which needs the
 * plugin's own glamour style, whose headings carry no `#` markers, and a pager told to print
 * neither fill lines nor an end prompt, so no markdown symbol and no pager furniture reaches
 * the screen (herdr-click-open-df7). A Mac with neither viewer gets the page as raw text in
 * micro, in a split below the clicked pane. The page is a temporary copy, and only mdd's edit
 * key (e, or v) reaches the Bead: the pane's EDITOR is the plugin's bead-edit.py, which opens
 * the Bead's description in micro and saves a change back (herdr-click-open-bje). Neither the
 * board, terminal-browser, the default browser nor AppleScript takes part.
 *
 * mdd and glow both take a placeholder such as <id> for an HTML tag and draw nothing for it,
 * so both are handed a page with each '<' outside code escaped; micro shows the page as
 * written, so it gets the page unescaped. mdd's half was checked against mddog 1.0.2 by
 * drawing a page through `mdd --headless`: the unescaped page draws "Run bd show in .", and
 * the escaped one draws "Run bd show <id> in <project>." with no backslash.
 *
 * The seam is the plugin's board action, run the way herdr runs it: `bash board.sh` in a
 * herdr pane, with the clicked link in `HERDR_PLUGIN_CLICKED_URL`. herdr, bd, mdd, glow and
 * micro are stand-ins at those edges, each writing down how it was called; the tools that
 * must not take part are stand-ins too, so their logs show a call that never happened. The
 * tests read those logs and the content the viewer was handed, not the script's internals.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const plugin = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The link bead-links.ts writes in a Project Manager's reply. */
const boardLink = (port: number, issue: string, repo: string): string =>
	`http://127.0.0.1:${port}/#/board?issue=${encodeURIComponent(issue)}&workspace=${encodeURIComponent(repo)}`;

/** Which of the page's viewers a temporary Mac has installed: mdd (mddog) first, then glow, then neither. */
type Viewers = "mdd" | "glow" | "none";

type Logs = {
	herdr: string;
	bd: string;
	bdCwd: string;
	mdd: string;
	glow: string;
	/** The pager glow was told to run, one line per glow call. */
	pager: string;
	micro: string;
	vi: string;
	terminalBrowser: string;
	open: string;
	osascript: string;
};

type Machine = {
	home: string;
	/** This temporary Mac's TMPDIR, where a clicked link's temporary file belongs. */
	temp: string;
	logs: Logs;
	/** A project folder in this temporary Mac. */
	project: (name: string) => string;
	/** `bd show` fails, as it does in a folder with no Beads database. */
	failBd: () => void;
	/** bd answers with this description for the Bead, in place of the fixture's own. */
	describe: (description: string) => void;
	/** mdd is told to press its edit key, e, the way mddog runs the page's `$EDITOR`. */
	pressE: () => void;
	/** The editor writes this text into the description file it is handed and quits. */
	editTo: (description: string) => void;
	/** `bd update` fails, as it does when the Bead's database cannot be written. */
	failUpdate: () => void;
	/** The Bead's description as `bd show --json` prints it in the named project. */
	show: (issue: string, repo: string) => string;
	click: (url: string) => Promise<{ status: number | null; stdout: string; stderr: string }>;
	/** The temporary entries the click left in this machine's TMPDIR. */
	temps: () => string[];
	/** The page mdd was handed, one block per mdd call. */
	mddPages: () => string[];
	/** The page glow was handed, one block per glow call. */
	glowPages: () => string[];
	/** The page micro was handed, one block per micro call. */
	microPages: () => string[];
	/** The pager glow was given, one command per glow call. */
	pagers: () => string[];
};

/** A stand-in at one edge: it writes down each call's arguments, then answers. */
const stub = (path: string, log: string, body: string) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		`#!/bin/sh\nprintf '%s\\n' --- >> '${log}'\nfor a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done\n${body}\n`,
	);
	chmodSync(path, 0o755);
};

/** The marker a keeping stand-in writes ahead of each block it keeps, so a reader can cut a log into blocks. */
const keptMarker = "---KEPT---";

/** A stand-in's body that keeps what it was handed, so an edit after it opened the file cannot hide what the pane first showed. */
const keepLast = (record: string) => `for last; do :; done
printf '%s\\n' '${keptMarker}' >> '${record}'
cat -- "$last" >> '${record}'`;

/** A log file's text, where a log never written is no text. */
const logged = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");

/** One temporary Mac with the named viewers installed, and stand-ins for herdr, bd, the viewers and the rest. */
const makeMachine = (options: { viewers?: Viewers } = {}): Machine => {
	const viewers = options.viewers ?? "mdd";
	const dir = mkdtempSync(join(tmpdir(), "factory-click-open-"));
	const home = join(dir, "home");
	// The plugin prepends $HOME/.local/bin, where herdr loads the tools it runs, to PATH.
	const bin = join(home, ".local", "bin");
	const temp = join(dir, "tmp");
	const logs: Logs = {
		herdr: join(dir, "herdr.log"),
		bd: join(dir, "bd.log"),
		bdCwd: join(dir, "bd-cwd.log"),
		mdd: join(dir, "mdd.log"),
		glow: join(dir, "glow.log"),
		pager: join(dir, "glow-pager.log"),
		micro: join(dir, "micro.log"),
		vi: join(dir, "vi.log"),
		terminalBrowser: join(dir, "terminal-browser.log"),
		open: join(dir, "open.log"),
		osascript: join(dir, "osascript.log"),
	};
	const fixtures = {
		splits: join(dir, "splits"),
		bdFails: join(dir, "bd-fails"),
		updateFails: join(dir, "bd-update-fails"),
		description: join(dir, "bd-description.json"),
		pressE: join(dir, "press-e"),
		edit: join(dir, "micro-edit"),
		mddPages: join(dir, "mdd-pages"),
		glowPages: join(dir, "glow-pages"),
		microPages: join(dir, "micro-pages"),
	};
	mkdirSync(home, { recursive: true });
	mkdirSync(bin, { recursive: true });
	mkdirSync(temp, { recursive: true });
	writeFileSync(fixtures.splits, "0\n");

	// The herdr stand-in: each split opens the next pane, and `pane run` runs the command in
	// it, the way a pane would.
	stub(
		join(bin, "herdr"),
		logs.herdr,
		`case "$1 $2" in
"pane split")
	n=$(cat '${fixtures.splits}')
	n=$((n + 1))
	printf '%s\\n' "$n" > '${fixtures.splits}'
	printf '{"result":{"pane":{"pane_id":"wA:p%d"}}}\\n' "$((n + 8))"
	;;
"pane run") eval "$4" ;;
esac
exit 0`,
	);

	// The bd stand-in: it says which project it ran in and how the Bead was asked for, and
	// answers with JSON for one Bead when it succeeds. A `bd update --body-file` replaces the
	// Bead's description with the file's text, so a later `bd show` prints what was saved.
	// BEADS_DIR must not reach it: bd would then read another project's database, as the real
	// bd would, and this stand-in fails the way it fails in a folder with no Beads database.
	stub(
		join(bin, "bd"),
		logs.bd,
		`printf '%s\\n' "$PWD" >> '${logs.bdCwd}'
if [ -n "\${BEADS_DIR:-}" ]; then
	echo 'Error: BEADS_DIR points bd at another database' >&2
	exit 1
fi
if [ -f '${fixtures.bdFails}' ]; then
	echo 'Error: no beads database found' >&2
	exit 1
fi
if [ "$1" = update ]; then
	if [ -f '${fixtures.updateFails}' ]; then
		echo 'Error: the Bead could not be updated' >&2
		exit 1
	fi
	shift
	body=
	while [ $# -gt 0 ]; do
		case "$1" in
		--body-file) body=$2; shift 2 ;;
		*) shift ;;
		esac
	done
	python3 -c 'import json, sys; open(sys.argv[2], "w").write(json.dumps(open(sys.argv[1]).read()))' "$body" '${fixtures.description}'
	exit 0
fi
description='"The board shows this **description**.\\n\\n- one\\n- two"'
if [ -f '${fixtures.description}' ]; then description=$(cat '${fixtures.description}'); fi
printf '%s\\n' '{"id":"'"$2"'","title":"Fixture Bead","description":'"$description"',"acceptance_criteria":"- met: a fixture criterion","status":"in_progress","issue_type":"task","priority":2,"assignee":"A Human","created_at":"2026-11-09T21:15:44Z"}'`,
	);

	// The mdd stand-in: it keeps the page it was handed. When the test asks it to press e, it
	// runs the pane's $EDITOR on that page the way mddog does (src/editor.rs: /bin/sh -c with
	// "$1" appended, which this helper ignores), then draws the page again, so the page it
	// keeps a second time is what mddog would redraw.
	if (viewers === "mdd") {
		stub(
			join(bin, "mdd"),
			logs.mdd,
			`${keepLast(fixtures.mddPages)}
if [ -f '${fixtures.pressE}' ]; then
	/bin/sh -c "$EDITOR \\"\\$1\\"" sh "$last"
	printf '%s\\n' '${keptMarker}' >> '${fixtures.mddPages}'
	cat -- "$last" >> '${fixtures.mddPages}'
fi`,
		);
	}

	// The glow stand-in: it keeps the page it was handed, the way micro's does, and writes
	// down the pager it would hand that page to, the way glow reads PAGER.
	if (viewers === "glow") {
		stub(
			join(bin, "glow"),
			logs.glow,
			`${keepLast(fixtures.glowPages)}
printf '%s\\n' "$PAGER" >> '${logs.pager}'`,
		);
	}

	// The micro stand-in: it keeps the content it was handed. When the test asks for an edit,
	// it writes the new text into that file and quits, the way a person would.
	stub(
		join(bin, "micro"),
		logs.micro,
		`${keepLast(fixtures.microPages)}
if [ -f '${fixtures.edit}' ]; then cat '${fixtures.edit}' > "$last"; fi`,
	);

	for (const [name, log] of [
		["vi", logs.vi],
		["terminal-browser", logs.terminalBrowser],
		["open", logs.open],
		["osascript", logs.osascript],
	] as const) {
		stub(join(bin, name), log, "exit 0");
	}

	const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TMPDIR: temp };
	// This run may itself be in a herdr pane; the test's own stand-ins are the pane it clicks in.
	for (const name of Object.keys(env)) if (name.startsWith("HERDR_")) delete env[name];
	// The pane's editor must be the one the plugin names, not the developer's own $EDITOR.
	delete env.EDITOR;
	env.HERDR_PANE_ID = "wA:p1";
	env.HERDR_WORKSPACE_ID = "wA";
	// The plugin's own knobs point at this machine's stand-ins, so neither the real herdr nor
	// a real viewer is reachable. A Mac without a viewer names one nothing provides; both
	// viewers are installed on the Mac that runs these tests, so a name is never enough.
	env.HERDR_BIN_PATH = join(bin, "herdr");
	env.MDD_BIN_PATH = viewers === "mdd" ? join(bin, "mdd") : "mdd-not-installed";
	env.GLOW_BIN_PATH = viewers === "glow" ? join(bin, "glow") : "glow-not-installed";
	// The pane inherits a BEADS_DIR for another project; both board.sh and the edit helper must
	// clear it so bd reads the Bead in the link's project. The bd stand-in fails when it is set.
	env.BEADS_DIR = join(dir, "another-project");
	const click = (url: string) =>
		new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
			const child = spawn("bash", [join(plugin, "board.sh")], {
				cwd: home,
				env: { ...env, HERDR_PLUGIN_CLICKED_URL: url },
			});
			let stdout = "";
			let stderr = "";
			child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
			child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
			child.on("close", (status) => resolve({ status, stdout, stderr }));
		});
	const project = (name: string) => {
		const path = join(dir, name);
		mkdirSync(path, { recursive: true });
		return path;
	};
	const failBd = () => writeFileSync(fixtures.bdFails, "");
	const describe = (description: string) => writeFileSync(fixtures.description, JSON.stringify(description));
	const pressE = () => writeFileSync(fixtures.pressE, "");
	const editTo = (description: string) => writeFileSync(fixtures.edit, description);
	const failUpdate = () => writeFileSync(fixtures.updateFails, "");
	// A person's bd has no BEADS_DIR for another project in its environment, so neither has this call.
	const show = (issue: string, repo: string): string => {
		const calledWith: NodeJS.ProcessEnv = { ...env };
		delete calledWith.BEADS_DIR;
		const answer = spawnSync(join(bin, "bd"), ["show", issue, "--json"], { cwd: repo, env: calledWith, encoding: "utf8" });
		assert.equal(answer.status, 0, `bd show succeeds in the fixture: ${answer.stderr}`);
		const parsed = JSON.parse(answer.stdout);
		return (Array.isArray(parsed) ? parsed[0] : parsed).description;
	};
	const temps = () => readdirSync(temp);
	const blocks = (path: string) => logged(path).split(`${keptMarker}\n`).slice(1);
	const mddPages = () => blocks(fixtures.mddPages);
	const glowPages = () => blocks(fixtures.glowPages);
	const microPages = () => blocks(fixtures.microPages);
	const pagers = () => logged(logs.pager).split("\n").filter((line) => line !== "");
	return { home, temp, logs, project, failBd, describe, pressE, editTo, failUpdate, show, click, temps, mddPages, glowPages, microPages, pagers };
};

/** The calls a stand-in was given, one array of arguments per call; a log never written is no calls. */
const calls = (path: string): string[][] => {
	const blocks: string[][] = [];
	let current: string[] | undefined;
	for (const line of logged(path).split("\n")) {
		if (line === "---") {
			current = [];
			blocks.push(current);
		} else if (line !== "" && current) current.push(line);
	}
	return blocks;
};

/** The projects bd was run in, in call order. */
const bdProjects = (mac: Machine): string[] => {
	const projects = logged(mac.logs.bdCwd).trim();
	return projects === "" ? [] : projects.split("\n");
};

/** The command herdr was asked to run in the new pane. */
const paneCommandOf = (run: string[]): string => run[3];

/**
 * The words of that command, as the pane's shell will read them back. The command is written
 * with printf %q, which escapes a space inside a word as a backslash and wraps awkward text in
 * single quotes.
 */
const paneWordsOf = (run: string[]): string[] => {
	const words: string[] = [];
	let word = "";
	let inWord = false;
	const command = paneCommandOf(run);
	for (let i = 0; i < command.length; i += 1) {
		const character = command[i];
		if (character === "\\") {
			word += command[(i += 1)];
			inWord = true;
		} else if (character === "'") {
			inWord = true;
			while (i + 1 < command.length && command[i + 1] !== "'") word += command[(i += 1)];
			i += 1;
		} else if (character === " ") {
			if (inWord) words.push(word);
			word = "";
			inWord = false;
		} else {
			word += character;
			inWord = true;
		}
	}
	if (inWord) words.push(word);
	return words;
};

/** The viewer a pane runs and the words it is handed, without the `exec` that closes the pane with it. */
const viewerWordsOf = (run: string[]): string[] => {
	const words = paneWordsOf(run);
	assert.equal(words[0], "exec", `the viewer replaces the pane's shell, so the pane closes with it: ${paneCommandOf(run)}`);
	return words.slice(1);
};

/** Whether the pane's command runs the named tool, by the name of one of its words. */
const runsTool = (run: string[], tool: string): boolean => paneWordsOf(run).some((word) => basename(word) === tool);

/** The temporary file a pane's viewer opened: the command's last word. */
const paneFileOf = (run: string[]): string => {
	const words = paneWordsOf(run);
	return words[words.length - 1];
};

/**
 * The click split the clicked pane in the named direction once, and ran one command in the pane
 * that split opened; the calls herdr was given, so a test can read the command that call ran.
 */
const assertSplit = (mac: Machine, direction: "right" | "down"): string[][] => {
	const herdr = calls(mac.logs.herdr);
	assert.deepEqual(
		herdr[0],
		["pane", "split", "--pane", "wA:p1", "--direction", direction, "--focus"],
		`the clicked pane is split ${direction}`,
	);
	assert.equal(herdr.length, 2, "the click splits once and runs one command in the new pane");
	return herdr;
};

/** The page went to a temporary file outside the project, so an edit cannot write back. */
const assertTempCopy = (mac: Machine, pageFile: string, repo: string) => {
	assert.ok(pageFile.startsWith(`${mac.temp}/`), `the Bead's page is a temporary file: ${pageFile}`);
	assert.ok(!pageFile.startsWith(`${repo}/`), "the temporary file is outside the project, so an edit cannot write back to the Bead");
};

/** The page carries bd's answer for this Bead as markdown, not bd show's boxed layout. */
const assertPage = (page: string, issue: string) => {
	assert.ok(page.startsWith(`# ${issue}: Fixture Bead\n`), `the page names the Bead in a heading: ${page}`);
	assert.ok(
		page.includes("## Description\n\nThe board shows this **description**.\n\n- one\n- two\n"),
		`the description is carried as the markdown it is: ${page}`,
	);
	assert.ok(
		page.includes("## Acceptance criteria\n\n- met: a fixture criterion\n"),
		`the acceptance criteria are carried as the markdown they are: ${page}`,
	);
};

/** glow renders the page with the plugin's own style, which prints no markdown marker. */
const assertRenderedWithoutMarkers = (run: string[]) => {
	const words = paneWordsOf(run);
	const flag = words.indexOf("-s");
	assert.notEqual(flag, -1, `glow is handed the plugin's own style: ${paneCommandOf(run)}`);
	const stylePath = words[flag + 1];
	assert.ok(existsSync(stylePath), `the style glow is handed exists: ${stylePath}`);
	const style = JSON.parse(readFileSync(stylePath, "utf8"));
	for (const heading of ["h1", "h2", "h3", "h4", "h5", "h6"]) {
		assert.doesNotMatch(
			style[heading]?.prefix ?? "",
			/#/,
			`the style prints no markdown marker before a ${heading} heading: ${JSON.stringify(style[heading])}`,
		);
	}
	assert.doesNotMatch(
		style.hr?.format ?? "",
		/[-*_]{3}/,
		`the style draws a rule as a line, not as the markdown that makes one: ${JSON.stringify(style.hr)}`,
	);
	for (const state of ["ticked", "unticked"]) {
		const marker = style.task?.[state] ?? "";
		assert.ok(marker, `the style draws a ${state} task item as a checkbox: ${JSON.stringify(style.task)}`);
		assert.doesNotMatch(
			marker,
			/[[\]]/,
			`the style draws a ${state} task item as a checkbox, not as markdown brackets: ${marker}`,
		);
	}
};

/** The pager is told to print neither its fill lines nor its end prompt. */
const assertQuietPager = (mac: Machine, index = 0) => {
	const pager = mac.pagers()[index];
	assert.ok(pager, "glow is given a pager");
	assert.match(pager, /(^|\s)less(\s|$)/, `the pager is less: ${pager}`);
	assert.match(pager, /(^|\s)--tilde(\s|$)/, `the pager leaves out its fill lines: ${pager}`);
	assert.match(pager, /-P ' '/, `the pager prints no prompt of its own: ${pager}`);
};

/** mdd draws and scrolls the page itself, so the pane hands it the page file and nothing else. */
const assertMddPage = (mac: Machine, run: string[], issue: string, repo: string, index = 0) => {
	assert.ok(runsTool(run, "mdd"), `the pane opens mdd: ${paneCommandOf(run)}`);
	// The pane hands mdd the page file and nothing after it: no style, no pager. The words
	// before mdd are env's assignment of the pane's EDITOR, which mdd uses for its edit key.
	const words = viewerWordsOf(run);
	const mddAt = words.findIndex((word) => basename(word) === "mdd");
	assert.equal(
		words.length - mddAt,
		2,
		`mdd is handed the page file alone, with no style and no pager: ${paneCommandOf(run)}`,
	);
	// The page keeps its .md name for mdd too (herdr-click-open-g2j), as it does for glow.
	assert.match(paneFileOf(run), /\.md$/, `mdd is handed a markdown file: ${paneCommandOf(run)}`);
	assertTempCopy(mac, paneFileOf(run), repo);
	const page = mac.mddPages()[index];
	assert.ok(page, "mdd is handed the Bead's page");
	assertPage(page, issue);
};

/** glow renders the page with the plugin's style and a quiet less, on a temporary copy of the Bead. */
const assertGlowPage = (mac: Machine, run: string[], issue: string, repo: string, index = 0) => {
	assert.ok(runsTool(run, "glow"), `the pane opens glow: ${paneCommandOf(run)}`);
	assert.ok(paneWordsOf(run).includes("-p"), `glow shows the page in its pager, a viewer that cannot write: ${paneCommandOf(run)}`);
	// glow renders only a file it takes for markdown by its name, and shows any other as text.
	assert.match(paneFileOf(run), /\.md$/, `glow is handed a markdown file, so it renders the page: ${paneCommandOf(run)}`);
	assertTempCopy(mac, paneFileOf(run), repo);
	assertRenderedWithoutMarkers(run);
	assertQuietPager(mac, index);
	const page = mac.glowPages()[index];
	assert.ok(page, "glow is handed the Bead's page");
	assertPage(page, issue);
};

/** One click against a temporary Mac, cleaned up whatever the click did. */
const withMachine = async (run: (mac: Machine) => Promise<void>, options: { viewers?: Viewers } = {}) => {
	const mac = makeMachine(options);
	try {
		await run(mac);
	} finally {
		rmSync(dirname(mac.home), { recursive: true, force: true });
	}
};

/** A board whose page and socket both fail, so a click that still asks it would show the error. */
async function failingBoard() {
	let requests = 0;
	let connections = 0;
	const server = createServer((_request, response) => {
		requests += 1;
		response.writeHead(500);
		response.end();
	});
	server.on("upgrade", (_request, socket) => {
		connections += 1;
		socket.destroy();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		port,
		requests: () => requests,
		connections: () => connections,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections?.();
				server.close(() => resolve());
			}),
	};
}

test("a board link splits the clicked pane to the right and opens mdd on the Bead's page, with no pager and no glow style", () =>
	withMachine(async (mac) => {
		const repo = mac.project("factory");

		const result = await mac.click(boardLink(3917, "fac-qpv.7.2", repo));
		assert.equal(result.status, 0, result.stderr);

		const herdr = assertSplit(mac, "right");
		assert.deepEqual(herdr[1].slice(0, 3), ["pane", "run", "wA:p9"], "mdd runs in the pane the split opened");

		assert.deepEqual(calls(mac.logs.bd), [["show", "fac-qpv.7.2", "--json"]], "bd show is asked for the link's Bead as JSON");
		assert.deepEqual(bdProjects(mac), [repo], "bd runs in the link's project");
		assertMddPage(mac, herdr[1], "fac-qpv.7.2", repo);
		assert.deepEqual(calls(mac.logs.glow), [], "glow is not started when mdd is installed");
	}));

test("pressing e in the mdd pane opens micro on the Bead's description, not vi and not the page file", () =>
	withMachine(async (mac) => {
		const repo = mac.project("factory");
		mac.pressE();

		const result = await mac.click(boardLink(3917, "fac-qpv.7.2", repo));
		assert.equal(result.status, 0, result.stderr);

		const herdr = assertSplit(mac, "right");
		const pageFile = paneFileOf(herdr[1]);
		const [opened] = calls(mac.logs.micro);
		assert.ok(opened, "pressing e opens micro");
		const descriptionFile = opened[opened.length - 1];
		assert.notEqual(descriptionFile, pageFile, "micro opens a file of its own, not the page mdd draws");
		assert.ok(
			descriptionFile.startsWith(`${mac.temp}/`),
			`micro opens a temporary file for the description: ${descriptionFile}`,
		);
		assert.deepEqual(calls(mac.logs.vi), [], "vi is not started");
		assert.equal(
			mac.microPages()[0],
			"The board shows this **description**.\n\n- one\n- two",
			"micro opens the Bead's description as bd holds it, without the page's heading and state",
		);
	}));

test("saving a changed description in micro writes it to the Bead, and the mddog page shows the new text", () =>
	withMachine(async (mac) => {
		const repo = mac.project("factory");
		const changed = "A rewritten description.\n\n- with a new list item";
		mac.pressE();
		mac.editTo(changed);

		const result = await mac.click(boardLink(3917, "fac-qpv.7.2", repo));
		assert.equal(result.status, 0, result.stderr);

		assert.equal(mac.show("fac-qpv.7.2", repo), changed, "bd show prints the text saved in micro");
		const pages = mac.mddPages();
		assert.equal(pages.length, 2, "mddog draws the page again when micro exits");
		assert.ok(
			pages[1].includes(`## Description\n\n${changed}\n`),
			`the redrawn page shows the description saved in the Bead: ${pages[1]}`,
		);
	}));

test("quitting micro without a change writes nothing to the Bead", () =>
	withMachine(async (mac) => {
		const repo = mac.project("factory");
		mac.pressE();

		const result = await mac.click(boardLink(3917, "fac-qpv.7.2", repo));
		assert.equal(result.status, 0, result.stderr);

		assert.deepEqual(
			calls(mac.logs.bd).filter((call) => call[0] === "update"),
			[],
			"an unchanged description is never written",
		);
		assert.equal(
			mac.show("fac-qpv.7.2", repo),
			"The board shows this **description**.\n\n- one\n- two",
			"the Bead keeps the description it had",
		);
	}));

test("a failed write keeps the edited description in a file the helper names", () =>
	withMachine(async (mac) => {
		const repo = mac.project("factory");
		const edited = "Text that could not be saved.\n\n- keep me";
		mac.pressE();
		mac.editTo(edited);
		mac.failUpdate();

		const result = await mac.click(boardLink(3917, "fac-qpv.7.2", repo));
		assert.equal(result.status, 0, result.stderr);

		const named = result.stderr.match(/your text is in (\S+)/)?.[1];
		assert.ok(named, `the helper names the file it kept: ${result.stderr}`);
		assert.equal(readFileSync(named, "utf8"), edited, "the named file holds exactly what was typed");
		const pages = mac.mddPages();
		assert.equal(pages.length, 2, "mddog draws the page again when micro exits");
		assert.ok(pages[1].includes(named), `the redrawn page names the file that kept the text: ${pages[1]}`);
	}));

test("a board link opens the Bead without the board, terminal-browser, the default browser or AppleScript, even when the board would fail", () =>
	withMachine(async (mac) => {
		const board = await failingBoard();
		try {
			const repo = mac.project("factory");

			const result = await mac.click(boardLink(board.port, "fac-qpv.7.2", repo));
			assert.equal(result.status, 0, result.stderr);

			assert.equal(mac.mddPages().length, 1, "mdd opens the Bead");
			assert.equal(board.requests(), 0, "no board page is asked for");
			assert.equal(board.connections(), 0, "the board's socket is never opened");
			assert.deepEqual(calls(mac.logs.terminalBrowser), [], "terminal-browser is not involved");
			assert.deepEqual(calls(mac.logs.open), [], "no default-browser tab is opened");
			assert.deepEqual(calls(mac.logs.osascript), [], "no AppleScript runs");
		} finally {
			await board.close();
		}
	}));

test("a second Ctrl-click opens another pane, with that link's Bead in that link's project", () =>
	withMachine(async (mac) => {
		const factory = mac.project("factory");
		const personal = mac.project("personal");

		const first = await mac.click(boardLink(3917, "fac-qpv.7.2", factory));
		assert.equal(first.status, 0, first.stderr);
		const second = await mac.click(boardLink(3918, "herdr-click-open-0h4", personal));
		assert.equal(second.status, 0, second.stderr);

		const herdr = calls(mac.logs.herdr);
		const splits = herdr.filter((call) => call[1] === "split");
		const runs = herdr.filter((call) => call[1] === "run");
		assert.equal(splits.length, 2, "each click splits the clicked pane");
		assert.deepEqual(splits.map((split) => split[5]), ["right", "right"], "both Beads render in a split to the right");
		assert.deepEqual(
			runs.map((run) => run[2]),
			["wA:p9", "wA:p10"],
			"each click opens its own pane",
		);
		assert.deepEqual(bdProjects(mac), [factory, personal], "each click reads the Bead in its own link's project");
		assert.deepEqual(
			mac.mddPages().map((page) => page.slice(0, page.indexOf("\n"))),
			["# fac-qpv.7.2: Fixture Bead", "# herdr-click-open-0h4: Fixture Bead"],
			"the first pane still shows the first Bead, and the second its own",
		);
		assertMddPage(mac, runs[0], "fac-qpv.7.2", factory);
		assertMddPage(mac, runs[1], "herdr-click-open-0h4", personal, 1);
	}));

/** A description with placeholders in angle brackets, the way Beads write them, in text and in code. */
const placeholders = "Run bd show <id> in <project>.\n\nIn code it stays: `bd show <id>`.\n\n```\nbd show <id> --json\n```";

/**
 * The page a drawing viewer is handed: each placeholder outside code written '\<id>', so the viewer
 * shows the text instead of dropping it as a tag, and code as written, where a backslash would show.
 */
const assertPlaceholdersKept = (page: string, viewer: string) => {
	assert.ok(
		page.includes("## Description\n\nRun bd show \\<id> in \\<project>.\n\nIn code it stays: `bd show <id>`.\n\n```\nbd show <id> --json\n```\n"),
		`the placeholders are kept for ${viewer} to show as text: ${page}`,
	);
};

test("a placeholder in angle brackets reaches mdd as the text mddog draws, not as an HTML tag it drops", () =>
	withMachine(async (mac) => {
		const repo = mac.project("factory");
		mac.describe(placeholders);

		const result = await mac.click(boardLink(3917, "fac-qpv.7.2", repo));
		assert.equal(result.status, 0, result.stderr);

		// mddog 1.0.2 draws an unescaped <id> as nothing and \<id> as <id>, as this test file's
		// header records.
		assertPlaceholdersKept(mac.mddPages()[0], "mddog");
	}));

test("a Mac without mdd renders the Bead with glow and its quiet pager, in a split to the right, as before", () =>
	withMachine(
		async (mac) => {
			const repo = mac.project("factory");

			const result = await mac.click(boardLink(3917, "fac-qpv.7.2", repo));
			assert.equal(result.status, 0, result.stderr);

			const herdr = assertSplit(mac, "right");
			assertGlowPage(mac, herdr[1], "fac-qpv.7.2", repo);
			assert.deepEqual(calls(mac.logs.mdd), [], "mdd is missing, so it cannot open the page");
		},
		{ viewers: "glow" },
	));

test("a placeholder in angle brackets reaches glow as text it shows, not as HTML it drops", () =>
	withMachine(
		async (mac) => {
			const repo = mac.project("factory");
			mac.describe(placeholders);

			const result = await mac.click(boardLink(3917, "fac-qpv.7.2", repo));
			assert.equal(result.status, 0, result.stderr);

			// glow takes <id> for an HTML tag and shows nothing for it; written \<id>, glow shows <id>.
			assertPlaceholdersKept(mac.glowPages()[0], "glow");
		},
		{ viewers: "glow" },
	));

test("a Mac without either viewer shows the placeholders as written, with no backslash added", () =>
	withMachine(
		async (mac) => {
			const repo = mac.project("factory");
			mac.describe(placeholders);

			const result = await mac.click(boardLink(3917, "fac-qpv.7.2", repo));
			assert.equal(result.status, 0, result.stderr);

			const [page] = mac.microPages();
			assert.ok(page.includes(`## Description\n\n${placeholders}\n`), `micro shows the description as bd holds it: ${page}`);
		},
		{ viewers: "none" },
	));

test("a board link whose Bead bd cannot show opens no pane, and the click says why", () =>
	withMachine(async (mac) => {
		const repo = mac.project("factory");
		mac.failBd();

		const result = await mac.click(boardLink(3917, "fac-qpv.7.2", repo));
		assert.notEqual(result.status, 0, "the click reports the failure");
		assert.match(result.stderr, /no beads database found/, "the message says what bd said");
		assert.deepEqual(calls(mac.logs.herdr), [], "no pane is opened for a Bead that could not be shown");
		assert.deepEqual(calls(mac.logs.mdd), [], "mdd is not started");
		assert.deepEqual(calls(mac.logs.glow), [], "glow is not started");
		assert.deepEqual(calls(mac.logs.micro), [], "micro is not started");
		assert.deepEqual(mac.temps(), [], "the click's temporary folder is cleaned up");
	}));

test("a Mac without mdd or glow opens the Bead as text below the clicked pane, read-only, never an empty pane", () =>
	withMachine(
		async (mac) => {
			const repo = mac.project("factory");

			const result = await mac.click(boardLink(3917, "fac-qpv.7.2", repo));
			assert.equal(result.status, 0, result.stderr);

			const herdr = assertSplit(mac, "down");
			assert.deepEqual(herdr[1].slice(0, 3), ["pane", "run", "wA:p9"], "micro runs in the pane the split opened");

			const command = paneCommandOf(herdr[1]);
			assert.match(command, /^exec micro -readonly true /, `the fallback pane also shows a read-only copy: ${command}`);
			assertTempCopy(mac, paneFileOf(herdr[1]), repo);
			const [page] = mac.microPages();
			assert.ok(page, "micro is handed the Bead's page");
			assertPage(page, "fac-qpv.7.2");
			assert.deepEqual(mac.mddPages(), [], "mdd is not started");
			assert.deepEqual(mac.glowPages(), [], "glow is not started");
		},
		{ viewers: "none" },
	));
