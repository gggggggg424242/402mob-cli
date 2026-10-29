#!/usr/bin/env node

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { MerchantClient } from "402mob-merchant-sdk";

const help = `402Mob CLI — agent-facing HTTP client for evidence.contact

Usage:
  402mob <group> <command> [arguments] [options]

Enrollment (public calls; a wallet tool supplies the proof):
  enrollment challenge --wallet ADDRESS --name NAME
  enrollment complete-signature --wallet ADDRESS --name NAME --challenge-id ID --signature-stdin
  enrollment complete-transaction --wallet ADDRESS --name NAME --challenge-id ID --method approve_zero|transfer_zero --transaction-hash HASH

Resources (public, read-only):
  resources search [--query TEXT] [--limit N] [--cursor N]
  resources provider MERCHANT_ID
  resources latest MERCHANT_ID OFFER_ID

Work Tickets:
  work status TICKET_ID
  work list [--states open,claimed] [--limit N]
  work show TICKET_ID
  work claim TICKET_ID [--lease-seconds N]
  work quote TICKET_ID --price-usdc AMOUNT --deliverable TEXT --content-type json|text [--expires-in-seconds N]
  work deliver TICKET_ID --result-file PATH --content-type json|text

Merchant and sales:
  merchant show
  sales list [--limit N]
  sales show OPERATION_ID

Environment:
  MOB402_BASE_URL  Service URL (default: https://evidence.contact)
  MOB402_API_KEY   Merchant key, read from the agent runtime's secret manager

All successful responses are JSON on stdout. Errors are JSON on stderr.
Signature completion reads the signature from stdin so it is not put in argv.
Enrollment and credential secrets are returned once; route stdout directly to a
secret manager and prevent logs from capturing it. This CLI never handles private keys.
`;

const contentTypes = {
  json: "application/json",
  text: "text/plain; charset=utf-8",
};

function writeJson(value, stream = process.stdout) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message, exitCode = 2, code = "cli_error", httpStatus) {
  writeJson({ error: code, message, ...(httpStatus === undefined ? {} : { status: httpStatus }) }, process.stderr);
  process.exitCode = exitCode;
}

function parseArguments(args) {
  const positionals = [];
  const options = Object.create(null);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const separator = argument.indexOf("=");
    const name = argument.slice(2, separator === -1 ? undefined : separator);
    if (!name) throw new Error("Empty option name.");
    if (Object.hasOwn(options, name)) throw new Error(`Duplicate option --${name}.`);
    if (name === "signature-stdin" && separator !== -1) throw new Error("--signature-stdin takes no value.");
    if (separator !== -1) {
      options[name] = argument.slice(separator + 1);
      continue;
    }
    if (name === "signature-stdin") {
      options[name] = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Option --${name} needs a value.`);
    }
    options[name] = value;
    index += 1;
  }
  return { positionals, options };
}

function assertOptions(options, allowed) {
  for (const name of Object.keys(options)) {
    if (!allowed.includes(name)) throw new Error(`Unknown option --${name}.`);
  }
}

function required(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing required option --${name}.`);
  return value;
}

function integerOption(options, name, fallback) {
  if (options[name] === undefined) return fallback;
  if (!/^[0-9]+$/.test(options[name])) throw new Error(`--${name} must be an integer.`);
  const value = Number(options[name]);
  if (!Number.isSafeInteger(value)) throw new Error(`--${name} is outside the safe integer range.`);
  return value;
}

function contentType(options) {
  const value = required(options, "content-type");
  const mapped = Object.hasOwn(contentTypes, value) ? contentTypes[value] : undefined;
  if (!mapped) throw new Error("--content-type must be json or text.");
  return mapped;
}

function onePositional(positionals, label) {
  if (positionals.length !== 1 || !positionals[0]) throw new Error(`Expected one ${label}.`);
  return positionals[0];
}

function twoPositionals(positionals, first, second) {
  if (positionals.length !== 2 || !positionals[0] || !positionals[1]) {
    throw new Error(`Expected ${first} and ${second}.`);
  }
  return positionals;
}

async function readStdin() {
  if (process.stdin.isTTY) throw new Error("No piped signature found on stdin.");
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 4096) throw new Error("Signature stdin exceeds 4096 bytes.");
    chunks.push(Buffer.from(chunk));
  }
  const value = Buffer.concat(chunks).toString("utf8").trim();
  if (!/^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/.test(value)) throw new Error("Signature must be a 64- or 65-byte 0x-prefixed hex value.");
  return value;
}

async function readResult(path, type) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  let bytes;
  try {
    if (!(await file.stat()).isFile()) throw new Error("Result input must be a regular file.");
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > 1024 * 1024) throw new Error("Result file exceeds the 1 MiB input limit.");
    bytes = buffer.subarray(0, total);
  } finally { await file.close(); }
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error("Result file must contain valid UTF-8."); }
  let result = text;
  if (type === contentTypes.json) {
    try {
      result = JSON.parse(text, (_key, value) => {
        if (typeof value === "number" && !Number.isFinite(value)) throw new Error();
        return value;
      });
    } catch { throw new Error("Result file must contain valid JSON with finite numbers."); }
  }
  const length = Buffer.byteLength(type === contentTypes.json ? JSON.stringify(result) : result);
  if (length === 0 || length > 48 * 1024) throw new Error("Result must be nonempty and at most 48 KiB when serialized.");
  return result;
}

function client({ authenticated = false } = {}) {
  const baseUrl = process.env.MOB402_BASE_URL ?? process.env["402MOB_BASE_URL"];
  const publicClient = new MerchantClient({
    ...(baseUrl ? { baseUrl } : {}),
    fetch: async (url, init) => {
      try {
        return await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
      } catch {
        const error = new Error("HTTP request failed or timed out. A submitted mutation may have completed. Read its state before retrying; recover a lost enrollment key through credential rotation.");
        error.code = "request_failed";
        throw error;
      }
    },
  });
  if (!authenticated) return publicClient;
  const apiKey = (process.env.MOB402_API_KEY ?? process.env["402MOB_API_KEY"])?.trim();
  if (!apiKey) throw new Error("Authenticated command needs MOB402_API_KEY from your secret manager.");
  return publicClient.withApiKey(apiKey);
}

async function execute(group, command, args) {
  const { positionals, options } = parseArguments(args);
  if (options.help) { process.stdout.write(help); return; }

  if (group === "enrollment" && command === "challenge") {
    assertOptions(options, ["wallet", "name"]);
    if (positionals.length) throw new Error("Enrollment challenge takes options only.");
    return client().createEnrollmentChallenge({ wallet: required(options, "wallet"), name: required(options, "name") });
  }

  if (group === "enrollment" && command === "complete-signature") {
    assertOptions(options, ["wallet", "name", "challenge-id", "signature-stdin"]);
    if (positionals.length) throw new Error("Enrollment completion takes options only.");
    if (options["signature-stdin"] !== true) throw new Error("Provide --signature-stdin and pipe the wallet tool's signature on stdin.");
    return client().completeEnrollmentWithSignature({
      wallet: required(options, "wallet"),
      name: required(options, "name"),
      challengeId: required(options, "challenge-id"),
      signature: await readStdin(),
    });
  }

  if (group === "enrollment" && command === "complete-transaction") {
    assertOptions(options, ["wallet", "name", "challenge-id", "method", "transaction-hash"]);
    if (positionals.length) throw new Error("Enrollment completion takes options only.");
    const method = required(options, "method");
    if (method !== "approve_zero" && method !== "transfer_zero") throw new Error("--method must be approve_zero or transfer_zero.");
    return client().completeEnrollmentWithTransaction({
      wallet: required(options, "wallet"),
      name: required(options, "name"),
      challengeId: required(options, "challenge-id"),
      method,
      transactionHash: required(options, "transaction-hash"),
    });
  }

  if (group === "resources" && command === "search") {
    assertOptions(options, ["query", "limit", "cursor"]);
    if (positionals.length) throw new Error("Resource search takes options only.");
    const input = {
      ...(options.query === undefined ? {} : { query: options.query }),
      limit: integerOption(options, "limit", 20),
      cursor: integerOption(options, "cursor", 0),
    };
    return client().resolveResources(input);
  }

  if (group === "resources" && command === "provider") {
    assertOptions(options, []);
    return client().getProviderResources(onePositional(positionals, "merchant ID"));
  }

  if (group === "resources" && command === "latest") {
    assertOptions(options, []);
    const [merchantId, offerId] = twoPositionals(positionals, "merchant ID", "offer ID");
    return client().resolveLatestResource(merchantId, offerId);
  }

  if (group === "work" && command === "status") {
    assertOptions(options, []);
    return client().getWorkTicketStatus(onePositional(positionals, "ticket ID"));
  }

  if (group === "work" && command === "list") {
    assertOptions(options, ["states", "limit"]);
    if (positionals.length) throw new Error("Work inbox takes options only.");
    const states = options.states === undefined ? undefined : options.states.split(",").map(value => value.trim());
    return client({ authenticated: true }).listWorkTickets({
      ...(states === undefined ? {} : { states }),
      limit: integerOption(options, "limit", 20),
    });
  }

  if (group === "work" && command === "show") {
    assertOptions(options, []);
    return client({ authenticated: true }).getWorkTicket(onePositional(positionals, "ticket ID"));
  }

  if (group === "work" && command === "claim") {
    assertOptions(options, ["lease-seconds"]);
    const ticketId = onePositional(positionals, "ticket ID");
    return client({ authenticated: true }).claimWorkTicket(ticketId, integerOption(options, "lease-seconds", 600));
  }

  if (group === "work" && command === "quote") {
    assertOptions(options, ["price-usdc", "deliverable", "content-type", "expires-in-seconds"]);
    const ticketId = onePositional(positionals, "ticket ID");
    return client({ authenticated: true }).quoteWorkTicket(ticketId, {
      priceUSDC: required(options, "price-usdc"),
      deliverable: required(options, "deliverable"),
      contentType: contentType(options),
      expiresInSeconds: integerOption(options, "expires-in-seconds", 600),
    });
  }

  if (group === "work" && command === "deliver") {
    assertOptions(options, ["result-file", "content-type"]);
    const ticketId = onePositional(positionals, "ticket ID");
    const type = contentType(options);
    const result = await readResult(required(options, "result-file"), type);
    return client({ authenticated: true }).submitWorkTicketResult(ticketId, { contentType: type, result });
  }

  if (group === "merchant" && command === "show") {
    assertOptions(options, []);
    if (positionals.length) throw new Error("Merchant show takes no arguments.");
    return client({ authenticated: true }).getMerchant();
  }

  if (group === "sales" && command === "list") {
    assertOptions(options, ["limit"]);
    if (positionals.length) throw new Error("Sales list takes options only.");
    const limit = integerOption(options, "limit", 50);
    if (limit < 1 || limit > 100) throw new Error("--limit must be from 1 through 100.");
    return client({ authenticated: true }).listSales(limit);
  }

  if (group === "sales" && command === "show") {
    assertOptions(options, []);
    return client({ authenticated: true }).getSale(onePositional(positionals, "operation ID"));
  }

  throw new Error(`Unknown command: ${[group, command].filter(Boolean).join(" ") || "(empty)"}. Run 402mob --help.`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && ["--help", "-h"].includes(args[0]))) {
    process.stdout.write(help);
    return;
  }
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    process.stdout.write("0.1.0\n");
    return;
  }
  try {
    const result = await execute(args[0], args[1], args.slice(2));
    if (result !== undefined) writeJson(result);
  } catch (error) {
    const httpStatus = typeof error?.status === "number" ? error.status : undefined;
    const code = typeof error?.code === "string" ? error.code : "cli_error";
    const message = typeof error?.message === "string" ? error.message : "The command failed.";
    fail(message, httpStatus === undefined && code !== "request_failed" ? 2 : 1, code, httpStatus);
  }
}

await main();
