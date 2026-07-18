import {useEffect, useState} from "react";
import type {Address} from "viem";
import {formatUnits} from "viem";
import {toUsdc, fromUsdc} from "@bankos/shared";
import type {UnlinkClient} from "@bankos/unlink-engine";
import {useWallet} from "../wallet/WalletContext";
import {useAsync, useNow} from "../hooks";
import {
  getMemberInfo,
  getPolicy,
  approveUsdc,
  depositToBank,
  registerMember,
  requestWithdraw,
  claimWithdraw,
  cancelWithdraw,
  borrow,
  repay,
  usdcAddress,
  savingsClaimable,
  claimSavings,
} from "../lib/contracts";
import {applyForPolicy} from "../lib/policy";
import {getUnlinkClient} from "../lib/unlink";
import {getBankMembers} from "../lib/events";
import {issueStatement, formatBand} from "../lib/statements";
import {getReputation} from "../lib/reputation";
import {getStockHoldings, STOCK_TOKENS_AVAILABLE} from "../lib/stocks";
import {EURC_ADDRESS, SUPPORTS_CRE, chain} from "../config";
import type {BankInfo} from "../lib/contracts";
import {Money, Badge, Field, Notice, Toggle, useTx, TxButton, Section} from "../components";

export function MemberPanel({bank, onChange, version}: {bank: BankInfo; onChange: () => void; version: number}) {
  const wallet = useWallet();
  const me = wallet.address!;
  const policy = useAsync(() => getPolicy(bank.address, me), [bank.address, me, version]);
  const member = useAsync(() => getMemberInfo(bank.address, me), [bank.address, me, version]);

  const eligible = policy.data?.canDeposit && (policy.data.expiry === 0 || policy.data.expiry * 1000 > Date.now());

  // Private by default (feature #2): the shielded balance is the headline; transparent checking is opt-in.
  return (
    <div className="grid cols-2" style={{alignItems: "start"}}>
      <div>
        <ComplianceCard bank={bank} policy={policy.data} onChange={() => {policy.refresh(); onChange();}} />
        <PrivateBalanceCard bank={bank} eligible={!!eligible} onChange={onChange} />
      </div>
      <div>
        {STOCK_TOKENS_AVAILABLE && <StockHoldingsCard owner={me} version={version} />}
        {eligible && bank.products.credit && policy.data?.canBorrow && (
          <CreditCard bank={bank} member={member} onChange={onChange} />
        )}
        {eligible && bank.products.checking && (
          <CheckingCard bank={bank} member={member} onChange={onChange} />
        )}
        {eligible && <DisclosureCard bank={bank} />}
      </div>
    </div>
  );
}

// ----------------------------------------------------------- tokenized stocks (Robinhood Chain)
function fmtStock(balance: bigint, decimals: number): string {
  const n = Number(formatUnits(balance, decimals));
  return n.toLocaleString(undefined, {maximumFractionDigits: 4});
}

/** Read-only: tokenized stocks the member holds in their wallet on Robinhood Chain (no custody here). */
function StockHoldingsCard({owner, version}: {owner: Address; version: number}) {
  const holdings = useAsync(() => getStockHoldings(owner), [owner, version]);
  const held = holdings.data?.filter((h) => h.balance > 0n) ?? [];
  return (
    <Section title="Stock holdings" icon="📈" action={<Badge tone="brand">Robinhood Chain</Badge>}>
      <p className="muted" style={{marginTop: 0}}>
        Tokenized stocks held in your wallet on {chain.name} — the full Robinhood experience alongside your
        bank. Custody stays in your own wallet.
      </p>
      {holdings.data === undefined ? (
        <div className="muted">Loading…</div>
      ) : held.length ? (
        held.map((h) => (
          <div className="kv" key={h.address}>
            <span className="k">{h.symbol} · {h.name}</span>
            <span className="val">{fmtStock(h.balance, h.decimals)}</span>
          </div>
        ))
      ) : (
        <Notice tone="info">No stock tokens yet — claim them from the Robinhood testnet faucet.</Notice>
      )}
    </Section>
  );
}

// ----------------------------------------------------------- selective disclosure (feature #7)
function DisclosureCard({bank}: {bank: BankInfo}) {
  const wallet = useWallet();
  const tx = useTx();
  const [disclose, setDisclose] = useState({balanceBand: true, compliance: true, activity: true});
  const [bandSize, setBandSize] = useState("10000"); // band width in human USDC
  const [out, setOut] = useState<{token: string; statement: any} | null>(null);
  const [copied, setCopied] = useState(false);

  async function generate() {
    setOut(null);
    setCopied(false);
    await tx.run(async () => {
      const c = await getUnlinkClient(wallet.walletClient!, wallet.address!);
      const res = await issueStatement({
        subject: c.getAddress(),
        bank: bank.address,
        member: wallet.address!,
        token: usdcAddress,
        bandSize: toUsdc(bandSize || "0").toString(),
        disclose,
      });
      setOut({token: res.token, statement: res.statement});
    }, "Statement issued ✓");
  }

  const claims = out?.statement?.claims;
  return (
    <Section title="Prove it — selective disclosure" icon="📄" action={<Badge tone="brand">Chainlink + Unlink</Badge>}>
      <p className="muted" style={{marginTop: 0}}>
        Generate a signed statement proving <em>only</em> what you choose — a balance <strong>range</strong>{" "}
        (never the exact figure), your compliance tier, or your activity — to share with an auditor or lender.
      </p>
      <Toggle on={disclose.balanceBand} onChange={(v) => setDisclose({...disclose, balanceBand: v})} label="Balance range" />
      <Toggle on={disclose.compliance} onChange={(v) => setDisclose({...disclose, compliance: v})} label="Compliance tier (on-chain, via CRE)" />
      <Toggle on={disclose.activity} onChange={(v) => setDisclose({...disclose, activity: v})} label="Account activity" />
      {disclose.balanceBand && (
        <Field label="Balance range width (USDC)" hint="Wider band = less precise = more private">
          <select className="input" value={bandSize} onChange={(e) => setBandSize(e.target.value)}>
            <option value="1000">±1,000</option>
            <option value="10000">±10,000</option>
            <option value="50000">±50,000</option>
            <option value="100000">±100,000</option>
          </select>
        </Field>
      )}
      <TxButton
        onClick={generate}
        className="btn primary block"
        pending={tx.pending}
        disabled={!disclose.balanceBand && !disclose.compliance && !disclose.activity}
      >
        Generate statement
      </TxButton>
      {tx.error && <Notice tone="err">{tx.error}</Notice>}

      {out && (
        <div style={{marginTop: 12}}>
          <div className="muted" style={{fontSize: 12, marginBottom: 6}}>Discloses:</div>
          <ul style={{margin: "0 0 10px", paddingLeft: 18, lineHeight: 1.8, fontSize: 13}}>
            {claims?.balanceBand && <li>balance in <strong>{formatBand(claims.balanceBand)}</strong></li>}
            {claims?.compliance && <li>compliance tier <strong>{claims.compliance.tier}</strong> ({claims.compliance.jurisdiction || "—"})</li>}
            {claims?.activity && <li>{claims.activity.privateTransfers} private transfer(s)</li>}
          </ul>
          <textarea className="input mono" readOnly style={{width: "100%", minHeight: 70, fontSize: 11}} value={out.token} />
          <button
            className="btn sm block"
            onClick={() => {
              navigator.clipboard?.writeText(out.token);
              setCopied(true);
            }}
          >
            {copied ? "Copied ✓" : "Copy statement to share"}
          </button>
          <div className="faint" style={{fontSize: 11, marginTop: 6}}>
            Anyone can verify this in the <strong>Discover</strong> tab — no access to your account needed.
          </div>
        </div>
      )}
    </Section>
  );
}

// ----------------------------------------------------------- compliance
function ComplianceCard({bank, policy, onChange}: {bank: BankInfo; policy: any; onChange: () => void}) {
  const wallet = useWallet();
  const tx = useTx();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    fullName: "Alice Avery",
    country: "US",
    region: "NY",
    dateOfBirth: "1990-04-01",
    governmentIdHash: "id-hash-0xabc123",
    requestsCredit: true,
  });
  const eligible = policy?.canDeposit && (policy.expiry === 0 || policy.expiry * 1000 > Date.now());

  async function apply() {
    await tx.run(async () => {
      const res = await applyForPolicy(bank.address, wallet.address!, {...form, sanctionsConsent: true});
      if (!res.approved) throw new Error(`Declined: ${res.reasons.join("; ")}`);
    }, "Approved — eligibility attested on-chain ✓");
    onChange();
  }

  if (!SUPPORTS_CRE) {
    return (
      <Section title="Compliance" icon="✅">
        <Notice tone="info">
          Confidential compliance runs on the Chainlink CRE workflow, which is available on Arc only and
          is <strong>not supported on {chain.name}</strong>. On-chain eligibility attestation is disabled
          on this chain.
        </Notice>
      </Section>
    );
  }

  return (
    <Section title="Compliance" icon="✅">
      {eligible ? (
        <>
          <div className="row" style={{gap: 8, marginBottom: 8}}>
            <Badge tone="green">Eligible · tier {policy.tier}</Badge>
            {policy.canBorrow && <Badge tone="brand">Credit cleared</Badge>}
          </div>
          <div className="kv"><span className="k">Jurisdiction</span><span className="val">{shortHex(policy.jurisdiction)}</span></div>
          <div className="kv"><span className="k">Expires</span><span className="val">{policy.expiry ? new Date(policy.expiry * 1000).toLocaleDateString() : "never"}</span></div>
          <div className="hint" style={{marginTop: 8}}>
            Screened confidentially by the Chainlink CRE workflow. Only this policy is on-chain — never your PII.
          </div>
        </>
      ) : (
        <>
          <p className="muted" style={{marginTop: 0}}>
            Submit KYC to the Chainlink CRE workflow to unlock deposits{bank.products.credit ? " and credit" : ""}.
            Your data is screened confidentially; only an eligibility policy is written on-chain.
          </p>
          {!open ? (
            <button className="btn primary" onClick={() => setOpen(true)}>
              Start onboarding
            </button>
          ) : (
            <>
              <div className="grid cols-2" style={{gap: 10}}>
                <Field label="Full name"><input value={form.fullName} onChange={(e) => setForm({...form, fullName: e.target.value})} /></Field>
                <Field label="Country (ISO-2)"><input value={form.country} onChange={(e) => setForm({...form, country: e.target.value})} /></Field>
                <Field label="Region"><input value={form.region} onChange={(e) => setForm({...form, region: e.target.value})} /></Field>
                <Field label="Date of birth"><input value={form.dateOfBirth} onChange={(e) => setForm({...form, dateOfBirth: e.target.value})} /></Field>
                <Field label="Gov. ID hash" hint="hash only — never the document"><input value={form.governmentIdHash} onChange={(e) => setForm({...form, governmentIdHash: e.target.value})} /></Field>
              </div>
              <TxButton onClick={apply} className="btn primary block" pending={tx.pending}>
                Submit to CRE workflow
              </TxButton>
              <div className="hint">Try country=KP for a sanctioned-jurisdiction rejection.</div>
            </>
          )}
        </>
      )}
      {tx.error && <Notice tone="err">{tx.error}</Notice>}
      {tx.ok && <Notice tone="ok">{tx.ok}</Notice>}
    </Section>
  );
}

// ----------------------------------------------------------- public checking
function CheckingCard({bank, member, onChange}: {bank: BankInfo; member: any; onChange: () => void}) {
  const wallet = useWallet();
  const tx = useTx();
  const now = useNow();
  const [amount, setAmount] = useState("1000");
  const m = member.data;

  async function deposit() {
    const amt = toUsdc(amount || "0");
    await tx.run(async () => {
      await approveUsdc(wallet.walletClient!, bank.address, amt);
      await depositToBank(wallet.walletClient!, bank.address, amt);
    }, `Deposited ${amount} USDC ✓`);
    member.refresh();
    onChange();
  }
  async function withdraw() {
    await tx.run(() => requestWithdraw(wallet.walletClient!, bank.address, toUsdc(amount || "0")), "Withdrawal requested ✓");
    member.refresh();
    onChange();
  }

  const pending = m?.pendingAmount > 0n;
  const remaining = m ? m.pendingUnlockAt - now : 0;
  const savings = useAsync(() => savingsClaimable(bank.address, wallet.address!), [bank.address, wallet.address, tx.ok]);

  async function claim() {
    await tx.run(() => claimSavings(wallet.walletClient!, bank.address), "Savings claimed ✓");
    savings.refresh();
    member.refresh();
    onChange();
  }

  return (
    <Section title="Transparent checking" icon="💵" action={<Badge tone="amber">optional · public</Badge>}>
      <div className="hint" style={{marginTop: 0, marginBottom: 8}}>
        Balances here are <strong>publicly visible</strong> on-chain. Your bank balance is private by
        default (left) — use transparent checking only if you want a publicly-auditable balance.
      </div>
      <div className="kv"><span className="k">Your deposit balance</span><span className="val">{m ? <Money v={m.deposit} /> : "…"}</span></div>
      <div className="kv">
        <span className="k">Earned savings (yield) <span className="private-tag">APY</span></span>
        <span className="val">
          {savings.data !== undefined ? <Money v={savings.data} /> : "…"}
          {savings.data !== undefined && savings.data > 0n && (
            <button className="btn primary sm" style={{marginLeft: 8}} onClick={claim} disabled={tx.pending}>Claim</button>
          )}
        </span>
      </div>
      <div className="inline-input" style={{marginTop: 12}}>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} />
        <TxButton onClick={deposit} className="btn primary" pending={tx.pending}>Deposit</TxButton>
        <TxButton onClick={withdraw} className="btn" pending={tx.pending}>Request withdraw</TxButton>
      </div>
      {pending && (
        <div className="card" style={{marginTop: 12, background: "var(--bg-elev)"}}>
          <div className="row between">
            <span>Pending withdrawal: <Money v={m.pendingAmount} /></span>
            {remaining > 0 ? <Badge tone="amber">unlocks in {remaining}s</Badge> : <Badge tone="green">ready</Badge>}
          </div>
          <div className="row" style={{gap: 8, marginTop: 10}}>
            <TxButton onClick={() => tx.run(() => claimWithdraw(wallet.walletClient!, bank.address), "Claimed ✓").then(() => {member.refresh(); onChange();})} className="btn primary sm" pending={tx.pending} disabled={remaining > 0}>Claim</TxButton>
            <TxButton onClick={() => tx.run(() => cancelWithdraw(wallet.walletClient!, bank.address), "Cancelled ✓").then(() => {member.refresh(); onChange();})} className="btn sm" pending={tx.pending}>Cancel</TxButton>
          </div>
        </div>
      )}
      {tx.error && <Notice tone="err">{tx.error}</Notice>}
      {tx.ok && <Notice tone="ok">{tx.ok}</Notice>}
    </Section>
  );
}

// ----------------------------------------------------------- credit
function CreditCard({bank, member, onChange}: {bank: BankInfo; member: any; onChange: () => void}) {
  const wallet = useWallet();
  const tx = useTx();
  const [amount, setAmount] = useState("1000");
  const m = member.data;

  // reputation-based credit (feature #8): score on-chain repayment history into an unlocked limit
  const rep = useAsync(
    () =>
      getReputation(
        bank.address,
        wallet.address!,
        m ? Number(fromUsdc(m.debt)) : 0,
        Number(fromUsdc(bank.risk.maxCreditPerBorrower)),
      ),
    [bank.address, wallet.address, m?.debt, tx.ok],
  );

  async function doBorrow() {
    await tx.run(() => borrow(wallet.walletClient!, bank.address, toUsdc(amount || "0")), "Borrowed ✓");
    member.refresh();
    onChange();
  }
  async function doRepay() {
    const amt = toUsdc(amount || "0");
    await tx.run(async () => {
      await approveUsdc(wallet.walletClient!, bank.address, amt);
      await repay(wallet.walletClient!, bank.address, wallet.address!, amt);
    }, "Repaid ✓");
    member.refresh();
    onChange();
  }

  const r = rep.data;
  return (
    <Section title="Credit line" icon="💳" action={r ? <Badge tone={r.tier >= 3 ? "green" : r.tier >= 2 ? "brand" : "amber"}>reputation tier {r.tier}</Badge> : undefined}>
      {r && (
        <div className="card" style={{background: "var(--surface-2, rgba(0,0,0,0.02))", padding: 12, marginBottom: 12}}>
          <div className="kv"><span className="k">Reputation score</span><span className="val mono">{r.score}/100</span></div>
          <div className="kv"><span className="k">Repayment-unlocked credit</span><span className="val"><Money v={toUsdc(String(r.recommendedLimitUsdc))} /></span></div>
          <div className="bar" style={{height: 6, borderRadius: 4, background: "rgba(0,0,0,0.08)", overflow: "hidden", margin: "8px 0"}}>
            <div style={{width: `${r.multiplier * 100}%`, height: "100%", background: "var(--brand, #6c5ce7)"}} />
          </div>
          <div className="hint">
            {r.factors.length ? r.factors.join(" · ") : "Borrow and repay on time to build reputation"} — unlocks up to the bank cap of <Money v={bank.risk.maxCreditPerBorrower} />.
          </div>
        </div>
      )}
      <div className="kv"><span className="k">Credit limit</span><span className="val">{m ? <Money v={m.creditLimit} /> : "…"}</span></div>
      <div className="kv"><span className="k">Outstanding debt</span><span className="val">{m ? <Money v={m.debt} /> : "…"}</span></div>
      <div className="kv"><span className="k">Available to draw</span><span className="val">{m ? <Money v={m.availableCredit} /> : "…"}</span></div>
      {m && m.creditLimit === 0n && <div className="hint" style={{marginTop: 8}}>No line yet — ask the steward to open one (they can grant up to your reputation-unlocked limit).</div>}
      <div className="inline-input" style={{marginTop: 12}}>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} />
        <TxButton onClick={doBorrow} className="btn primary" pending={tx.pending} disabled={!m || m.creditLimit === 0n}>Borrow</TxButton>
        <TxButton onClick={doRepay} className="btn" pending={tx.pending} disabled={!m || m.debt === 0n}>Repay</TxButton>
      </div>
      {tx.error && <Notice tone="err">{tx.error}</Notice>}
      {tx.ok && <Notice tone="ok">{tx.ok}</Notice>}
    </Section>
  );
}

// ----------------------------------------------------------- private (Unlink)
function PrivateBalanceCard({bank, eligible, onChange}: {bank: BankInfo; eligible: boolean; onChange: () => void}) {
  const wallet = useWallet();
  const tx = useTx();
  const [client, setClient] = useState<UnlinkClient | null>(null);
  const [balance, setBalance] = useState<bigint>(0n);
  const [shieldAmt, setShieldAmt] = useState("500");
  const [xferAmt, setXferAmt] = useState("100");
  const [xferTo, setXferTo] = useState("");
  const [wdAmt, setWdAmt] = useState("100");
  const [wdTo, setWdTo] = useState(wallet.address ?? "");
  const directory = useAsync(() => getBankMembers(bank.address), [bank.address]);

  // recurring private payments / payroll (feature #6): a saved batch of private transfers
  type PayRow = {to: string; amount: string};
  const payrollKey = `charter.payroll.${bank.address}.${wallet.address}`;
  const [cadence, setCadence] = useState("monthly");
  const [payroll, setPayroll] = useState<PayRow[]>([{to: "", amount: ""}]);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(payrollKey) || "null");
      if (saved?.rows?.length) {
        setPayroll(saved.rows);
        setCadence(saved.cadence ?? "monthly");
      }
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payrollKey]);
  const savePayroll = (rows: PayRow[], cad: string) => {
    setPayroll(rows);
    setCadence(cad);
    try {
      localStorage.setItem(payrollKey, JSON.stringify({rows, cadence: cad}));
    } catch {
      /* ignore */
    }
  };
  const [payrollStatus, setPayrollStatus] = useState<string>();

  // multi-currency FX (feature #10)
  const [eurcBalance, setEurcBalance] = useState<bigint>(0n);
  const [swapAmt, setSwapAmt] = useState("100");
  const [swapDir, setSwapDir] = useState<"USDC->EURC" | "EURC->USDC">("USDC->EURC");

  async function refreshBal(c: UnlinkClient) {
    setBalance(await c.getBalance(usdcAddress));
    setEurcBalance(await c.getBalance(EURC_ADDRESS));
  }

  async function swapFx() {
    if (!client) return;
    const [from, to] = swapDir === "USDC->EURC" ? [usdcAddress, EURC_ADDRESS] : [EURC_ADDRESS, usdcAddress];
    await tx.run(async () => {
      await client.fxSwap!(from, to, toUsdc(swapAmt || "0"));
      await refreshBal(client);
    }, "Swapped privately ✓");
  }

  async function setup() {
    await tx.run(async () => {
      const c = await getUnlinkClient(wallet.walletClient!, wallet.address!);
      // ensure the bank knows this member's unlink pointer
      try {
        await registerMember(wallet.walletClient!, bank.address, c.getAddress());
      } catch { /* already a member */ }
      setClient(c);
      await refreshBal(c);
    }, "Private account ready ✓");
    onChange();
  }

  async function shield() {
    if (!client) return;
    await tx.run(async () => {
      await client.deposit(usdcAddress, toUsdc(shieldAmt || "0"));
      await refreshBal(client);
    }, `Shielded ${shieldAmt} USDC ✓`);
  }
  async function transfer() {
    if (!client) return;
    await tx.run(async () => {
      await client.privateTransfer(usdcAddress, xferTo.trim(), toUsdc(xferAmt || "0"));
      await refreshBal(client);
    }, "Private transfer sent (off-chain, hidden) ✓");
  }
  async function withdraw() {
    if (!client) return;
    await tx.run(async () => {
      await client.withdraw(usdcAddress, wdTo.trim() as Address, toUsdc(wdAmt || "0"));
      await refreshBal(client);
    }, "Withdrawn on-chain to address ✓");
  }
  async function runPayroll() {
    if (!client) return;
    const rows = payroll.filter((r) => r.to.trim() && Number(r.amount) > 0);
    if (rows.length === 0) return;
    await tx.run(async () => {
      let done = 0;
      for (const r of rows) {
        setPayrollStatus(`Paying ${done + 1}/${rows.length}…`);
        await client.privateTransfer(usdcAddress, r.to.trim(), toUsdc(r.amount));
        done++;
      }
      setPayrollStatus(undefined);
      await refreshBal(client);
    }, `Paid ${rows.length} recipient(s) privately ✓`);
  }
  const payrollTotal = payroll.reduce((s, r) => s + (Number(r.amount) > 0 ? toUsdc(r.amount) : 0n), 0n);

  return (
    <Section title="Private balance" icon="🔒" action={<><Badge tone="green">default</Badge> <Badge tone="brand">Unlink</Badge></>}>
      {!eligible ? (
        <div className="muted">Complete compliance to use private banking.</div>
      ) : !client ? (
        <>
          <p className="muted" style={{marginTop: 0}}>
            Derive a private Unlink account from your wallet. Balances and transfers stay off the public
            ledger — only deposits and withdrawals touch the chain.
          </p>
          <TxButton onClick={setup} className="btn primary block" pending={tx.pending}>
            Set up private account
          </TxButton>
        </>
      ) : (
        <>
          <div className="stat" style={{marginBottom: 12}}>
            <div className="v"><Money v={balance} /></div>
            <div className="l">Private (shielded) balance</div>
          </div>
          <div className="kv">
            <span className="k">Your unlink address</span>
            <span className="val" title={client.getAddress()} style={{cursor: "copy"}} onClick={() => navigator.clipboard?.writeText(client.getAddress())}>
              {client.getAddress().slice(0, 18)}… 📋
            </span>
          </div>
          <div className="kv">
            <span className="k">EURC balance (private)</span>
            <span className="val"><Money v={eurcBalance} sym="EURC" /></span>
          </div>

          <div className="sep" />
          <div className="lbl muted" style={{fontSize: 13}}>FX swap <span className="private-tag">(private, in-shield)</span></div>
          <div className="inline-input">
            <select className="input" value={swapDir} onChange={(e) => setSwapDir(e.target.value as "USDC->EURC" | "EURC->USDC")}>
              <option value="USDC->EURC">USDC → EURC</option>
              <option value="EURC->USDC">EURC → USDC</option>
            </select>
            <input value={swapAmt} onChange={(e) => setSwapAmt(e.target.value)} />
            <TxButton onClick={swapFx} className="btn" pending={tx.pending}>Swap</TxButton>
          </div>
          <div className="faint" style={{fontSize: 11, marginTop: 4}}>
            ~0.9860 EURC/USDC · indicative LI.FI Arc rate · swapped privately in the shielded ledger
          </div>

          <div className="sep" />
          <div className="lbl muted" style={{fontSize: 13}}>Shield USDC → private</div>
          <div className="inline-input">
            <input value={shieldAmt} onChange={(e) => setShieldAmt(e.target.value)} />
            <TxButton onClick={shield} className="btn primary" pending={tx.pending}>Shield</TxButton>
          </div>

          <div className="lbl muted" style={{fontSize: 13, marginTop: 12}}>Private transfer <span className="private-tag">(hidden, off-chain)</span></div>
          <Field label="" hint={directory.data && directory.data.length > 1 ? "Pick a member from the directory or paste an unlink1… address." : undefined}>
            <input list="member-dir" placeholder="recipient unlink1… address" value={xferTo} onChange={(e) => setXferTo(e.target.value)} />
            <datalist id="member-dir">
              {directory.data
                ?.filter((m) => m.unlinkAccount && m.unlinkAccount !== client.getAddress())
                .map((m) => (
                  <option key={m.address} value={m.unlinkAccount}>
                    {m.address.slice(0, 8)}…{m.address.slice(-4)}
                  </option>
                ))}
            </datalist>
          </Field>
          <div className="inline-input">
            <input value={xferAmt} onChange={(e) => setXferAmt(e.target.value)} />
            <TxButton onClick={transfer} className="btn primary" pending={tx.pending} disabled={!xferTo}>Send private</TxButton>
          </div>

          <div className="lbl muted" style={{fontSize: 13, marginTop: 12}}>Withdraw → EVM address</div>
          <Field label=""><input placeholder="0x… recipient" value={wdTo} onChange={(e) => setWdTo(e.target.value)} /></Field>
          <div className="inline-input">
            <input value={wdAmt} onChange={(e) => setWdAmt(e.target.value)} />
            <TxButton onClick={withdraw} className="btn" pending={tx.pending} disabled={!wdTo}>Withdraw</TxButton>
          </div>

          <div className="sep" />
          <div className="row between">
            <span className="lbl muted" style={{fontSize: 13}}>Recurring payments / payroll <span className="private-tag">(private)</span></span>
            <select className="select" value={cadence} onChange={(e) => savePayroll(payroll, e.target.value)}>
              <option value="one-time">one-time</option>
              <option value="weekly">weekly</option>
              <option value="monthly">monthly</option>
            </select>
          </div>
          {payroll.map((row, i) => (
            <div className="inline-input" style={{marginTop: 6}} key={i}>
              <input list="member-dir" placeholder="recipient unlink1…" value={row.to}
                onChange={(e) => savePayroll(payroll.map((r, j) => (j === i ? {...r, to: e.target.value} : r)), cadence)} />
              <input style={{maxWidth: 90}} placeholder="amt" value={row.amount}
                onChange={(e) => savePayroll(payroll.map((r, j) => (j === i ? {...r, amount: e.target.value} : r)), cadence)} />
              <button className="btn sm" title="remove" onClick={() => savePayroll(payroll.length > 1 ? payroll.filter((_, j) => j !== i) : [{to: "", amount: ""}], cadence)}>✕</button>
            </div>
          ))}
          <div className="row" style={{gap: 8, marginTop: 8}}>
            <button className="btn sm" onClick={() => savePayroll([...payroll, {to: "", amount: ""}], cadence)}>+ Add</button>
            <TxButton onClick={runPayroll} className="btn primary sm" pending={tx.pending} disabled={payrollTotal === 0n}>Run payroll now</TxButton>
          </div>
          <div className="hint">
            Saved {cadence} batch · total {fromUsdc(payrollTotal)} USDC across {payroll.filter((r) => r.to.trim() && Number(r.amount) > 0).length} recipient(s) — runs as private transfers (off-chain, hidden). {payrollStatus ?? ""}
          </div>
        </>
      )}
      {tx.error && <Notice tone="err">{tx.error}</Notice>}
      {tx.ok && <Notice tone="ok">{tx.ok}</Notice>}
    </Section>
  );
}

function shortHex(h?: string) {
  return h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "—";
}
