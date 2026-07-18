import {useState} from "react";
import type {Address} from "viem";
import {toUsdc, fromUsdc, ARC_USDC_ERC20, ARC_EURC, type Products} from "@bankos/shared";
import type {UnlinkClient} from "@bankos/unlink-engine";
import {useWallet} from "../wallet/WalletContext";
import {useAsync} from "../hooks";
import {deployment, ENABLE_LIFI, CHAIN_ID} from "../config";
import {
  openCreditLine,
  allocateToStrategy,
  redeemFromStrategy,
  setPaused,
  configureProducts,
  strategyShares,
  getPolicy,
  harvestYield,
  setStewardSpread,
  claimStewardFees,
  stewardFees,
  stewardSpreadBps,
  listBanks,
  getBankInfo,
  usdcAddress,
  type BankInfo,
} from "../lib/contracts";
import {getBankMembers} from "../lib/events";
import {getUnlinkClient} from "../lib/unlink";
import {registerTreasury, getTreasury, getSettlements, getNet} from "../lib/settlements";
import {getLifiQuote, executeLifiRoute, type LifiQuote} from "../lib/lifi";
import {proposeTreasuryMove, fetchClaudeReview} from "../lib/treasuryAgent";
import {useLedger} from "../ledger/LedgerProvider";
import {clearSign} from "../ledger/erc7730";
import {Money, Badge, Field, Notice, Toggle, useTx, TxButton, Section} from "../components";

export function StewardPanel({bank, onChange, version}: {bank: BankInfo; onChange: () => void; version: number}) {
  return (
    <div className="grid cols-2" style={{alignItems: "start"}}>
      <div>
        <CreditDesk bank={bank} onChange={onChange} />
        <MemberRoster bank={bank} version={version} />
        <ControlsCard bank={bank} onChange={onChange} />
      </div>
      <div>
        <TreasuryAgentCard bank={bank} onChange={onChange} />
        <TreasuryDesk bank={bank} onChange={onChange} version={version} />
        <InterBankSettlementCard bank={bank} />
        {ENABLE_LIFI && <LifiCard bank={bank} />}
      </div>
    </div>
  );
}

// ----------------------------------------------------------- inter-bank settlement (feature #9)
function InterBankSettlementCard({bank}: {bank: BankInfo}) {
  const wallet = useWallet();
  const tx = useTx();
  const [client, setClient] = useState<UnlinkClient | null>(null);
  const [treasuryBal, setTreasuryBal] = useState<bigint>(0n);
  const [counterparty, setCounterparty] = useState<string>("");
  const [amount, setAmount] = useState("1000");
  const [memo, setMemo] = useState("");

  const others = useAsync(async () => {
    const addrs = (await listBanks()).filter((a) => a.toLowerCase() !== bank.address.toLowerCase());
    return Promise.all(addrs.map(getBankInfo));
  }, [bank.address]);
  const settlements = useAsync(() => getSettlements(bank.address), [bank.address, tx.ok]);
  const net = useAsync(
    () => (counterparty ? getNet(bank.address, counterparty as Address) : Promise.resolve(null)),
    [bank.address, counterparty, tx.ok],
  );

  async function setupTreasury() {
    await tx.run(async () => {
      const c = await getUnlinkClient(wallet.walletClient!, wallet.address!);
      await registerTreasury(bank.address, c.getAddress());
      setClient(c);
      setTreasuryBal(await c.getBalance(usdcAddress));
    }, "Settlement treasury published ✓");
  }
  async function shieldToTreasury() {
    if (!client) return;
    await tx.run(async () => {
      await client.deposit(usdcAddress, toUsdc(amount || "0"));
      setTreasuryBal(await client.getBalance(usdcAddress));
    }, `Shielded ${amount} USDC to treasury ✓`);
  }
  async function settle() {
    if (!client || !counterparty) return;
    await tx.run(async () => {
      const dest = await getTreasury(counterparty as Address);
      if (!dest) throw new Error("counterparty bank hasn't published a settlement treasury yet");
      await client.settle!(usdcAddress, dest, toUsdc(amount || "0"), {
        fromBank: bank.address,
        toBank: counterparty as Address,
        memo,
      });
      setTreasuryBal(await client.getBalance(usdcAddress));
    }, "Settled privately ✓");
  }

  const n = net.data;
  return (
    <Section title="Inter-bank settlement" icon="🏦" action={<Badge tone="brand">Unlink · private</Badge>}>
      <p className="muted" style={{marginTop: 0}}>
        Settle obligations with another bank on the factory — a real private transfer between treasuries,
        hidden from the public chain. The engine nets your mutual positions.
      </p>
      {!client ? (
        <TxButton onClick={setupTreasury} className="btn primary block" pending={tx.pending}>
          Publish settlement treasury
        </TxButton>
      ) : (
        <>
          <div className="kv"><span className="k">Treasury (private)</span><span className="val"><Money v={treasuryBal} /></span></div>
          {(others.data?.length ?? 0) === 0 ? (
            <div className="hint" style={{marginTop: 8}}>No counterparty banks chartered yet.</div>
          ) : (
            <>
              <Field label="Counterparty bank">
                <select className="input" value={counterparty} onChange={(e) => setCounterparty(e.target.value)}>
                  <option value="">Select a bank…</option>
                  {others.data?.map((b) => (
                    <option key={b.address} value={b.address}>{b.name}</option>
                  ))}
                </select>
              </Field>
              <div className="grid cols-2" style={{gap: 10}}>
                <Field label="Amount (USDC)"><input className="input" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
                <Field label="Memo"><input className="input" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="net rent float" /></Field>
              </div>
              <div className="row" style={{gap: 8}}>
                <TxButton onClick={shieldToTreasury} className="btn" pending={tx.pending}>Shield to treasury</TxButton>
                <TxButton onClick={settle} className="btn primary" pending={tx.pending} disabled={!counterparty}>Settle privately</TxButton>
              </div>
              {n && Number(n.count) > 0 && (
                <div className="notice info" style={{marginTop: 10}}>
                  Net position: {BigInt(n.net) === 0n ? "settled flat" : BigInt(n.net) > 0n
                    ? <>you owe <Money v={BigInt(n.net)} /></>
                    : <>owed to you <Money v={-BigInt(n.net)} /></>} <span className="faint">({n.count} settlement{n.count === 1 ? "" : "s"})</span>
                </div>
              )}
            </>
          )}
        </>
      )}
      {tx.error && <Notice tone="err">{tx.error}</Notice>}
      {tx.ok && <Notice tone="ok">{tx.ok}</Notice>}
      {(settlements.data?.length ?? 0) > 0 && (
        <div style={{marginTop: 12}}>
          <div className="muted" style={{fontSize: 12, marginBottom: 6}}>Recent settlements (private)</div>
          <ul style={{margin: 0, paddingLeft: 16, fontSize: 12, lineHeight: 1.8}}>
            {settlements.data?.slice(0, 5).map((s) => (
              <li key={s.id}>
                {s.fromBank.toLowerCase() === bank.address.toLowerCase() ? "→ paid" : "← received"}{" "}
                <Money v={BigInt(s.amount)} />{s.memo ? ` · ${s.memo}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

function TreasuryAgentCard({bank, onChange}: {bank: BankInfo; onChange: () => void}) {
  const wallet = useWallet();
  const ledger = useLedger();
  const tx = useTx();
  const proposal = proposeTreasuryMove(bank);
  const review = useAsync(() => fetchClaudeReview(bank, proposal), [bank.address, proposal.action, proposal.amount.toString()]);
  const rationale = review.data?.rationale ?? proposal.rationale;
  const risk = review.data?.risk ?? proposal.risk;
  const toneByRisk = {low: "green", medium: "amber", high: "red"} as const;

  async function execute() {
    if (proposal.action === "hold") return;
    await tx.run(async () => {
      if (proposal.action === "allocate") {
        await ledger.requestApproval(clearSign.allocate(bank.address, deployment.yieldVault, proposal.amount));
        await allocateToStrategy(wallet.walletClient!, bank.address, deployment.yieldVault, proposal.amount);
      } else {
        const sharesHeld = await strategyShares(bank.address, deployment.yieldVault);
        const shares = bank.strategyAssets > 0n ? (sharesHeld * proposal.amount) / bank.strategyAssets : sharesHeld;
        await ledger.requestApproval(clearSign.redeem(bank.address, deployment.yieldVault, shares, proposal.amount));
        await redeemFromStrategy(wallet.walletClient!, bank.address, deployment.yieldVault, shares);
      }
    }, "Agent move approved & executed ✓");
    onChange();
  }

  return (
    <Section title="Treasury agent" icon="🤖" action={<Badge tone="brand">{review.data ? "Claude + Ledger" : "AI + Ledger"}</Badge>}>
      <div className="agent-headline">
        <div className="agent-avatar">◆</div>
        <div style={{flex: 1}}>
          <strong>{proposal.headline}</strong>
          <div className="row wrap" style={{gap: 6, marginTop: 4}}>
            <Badge tone={toneByRisk[risk]}>{risk} risk</Badge>
            {review.data && <Badge tone={review.data.concur ? "green" : "amber"}>Claude {review.data.concur ? "concurs" : "flags"}</Badge>}
            {proposal.requiresLedger && <Badge tone="brand">Ledger approval required</Badge>}
            {proposal.action !== "hold" && <Badge>{proposal.action} · {fromUsdc(proposal.amount)} USDC</Badge>}
          </div>
        </div>
      </div>

      <div className="agent-reasoning">
        {rationale.map((r, i) => (
          <div className="agent-thought" key={i}>
            <span className="agent-bullet">›</span> {r}
          </div>
        ))}
        {review.data?.note && <div className="hint" style={{marginTop: 6}}>Claude: {review.data.note}</div>}
      </div>

      {proposal.action !== "hold" && (
        <>
          <div className="kv"><span className="k">Idle after</span><span className="val">{fromUsdc(proposal.projected.idleAfter)} USDC</span></div>
          <div className="kv"><span className="k">Deployed after</span><span className="val">{fromUsdc(proposal.projected.deployedAfter)} USDC</span></div>
          <TxButton onClick={execute} className="btn primary block" pending={tx.pending} disabled={!bank.products.yield}>
            {proposal.requiresLedger || ledger.enabled ? "✦ Approve on Ledger & execute" : "Execute agent move"}
          </TxButton>
          <div className="hint">The agent proposes; you approve on-device. Nothing moves without your signature.</div>
        </>
      )}
      {tx.error && <Notice tone="err">{tx.error}</Notice>}
      {tx.ok && <Notice tone="ok">{tx.ok}</Notice>}
    </Section>
  );
}

function MemberRoster({bank, version}: {bank: BankInfo; version: number}) {
  const roster = useAsync(async () => {
    const members = await getBankMembers(bank.address);
    return Promise.all(
      members.map(async (m) => ({...m, policy: await getPolicy(bank.address, m.address)})),
    );
  }, [bank.address, version]);

  return (
    <Section title="Members" icon="👥">
      {roster.loading && <div className="muted">Loading…</div>}
      {roster.data && roster.data.length === 0 && (
        <div className="muted">No members have registered a private account yet.</div>
      )}
      {roster.data?.map((m) => {
        const eligible = m.policy.canDeposit && (m.policy.expiry === 0 || m.policy.expiry * 1000 > Date.now());
        return (
          <div className="kv" key={m.address}>
            <span className="k mono" style={{cursor: "copy"}} title={m.address} onClick={() => navigator.clipboard?.writeText(m.address)}>
              {m.address.slice(0, 8)}…{m.address.slice(-4)} 📋
            </span>
            <span className="val">
              {eligible ? <Badge tone="green">tier {m.policy.tier}</Badge> : <Badge tone="amber">no policy</Badge>}
              {m.policy.canBorrow && <Badge tone="brand">credit</Badge>}
            </span>
          </div>
        );
      })}
      <div className="hint" style={{marginTop: 8}}>Click an address to copy it into the credit form.</div>
    </Section>
  );
}

function CreditDesk({bank, onChange}: {bank: BankInfo; onChange: () => void}) {
  const wallet = useWallet();
  const tx = useTx();
  const ledger = useLedger();
  const [member, setMember] = useState("");
  const [limit, setLimit] = useState("20000");

  async function open() {
    await tx.run(async () => {
      const m = member.trim() as Address;
      const lim = toUsdc(limit || "0");
      await ledger.requestApproval(clearSign.openCredit(bank.address, m, lim));
      await openCreditLine(wallet.walletClient!, bank.address, m, lim);
    }, "Credit line opened ✓");
    onChange();
  }

  return (
    <Section title="Credit lines" icon="💳">
      {!bank.products.credit && <Notice tone="info">Credit product is disabled for this bank.</Notice>}
      <Field label="Member address"><input placeholder="0x…" value={member} onChange={(e) => setMember(e.target.value)} /></Field>
      <Field label="Credit limit (USDC)" hint={`Max per borrower: ${fromUsdc(bank.risk.maxCreditPerBorrower)}`}>
        <input value={limit} onChange={(e) => setLimit(e.target.value)} />
      </Field>
      <TxButton onClick={open} className="btn primary block" pending={tx.pending} disabled={!bank.products.credit || !member}>
        Open credit line
      </TxButton>
      {tx.error && <Notice tone="err">{tx.error}</Notice>}
      {tx.ok && <Notice tone="ok">{tx.ok}</Notice>}
    </Section>
  );
}

function TreasuryDesk({bank, onChange, version}: {bank: BankInfo; onChange: () => void; version: number}) {
  const wallet = useWallet();
  const tx = useTx();
  const ledger = useLedger();
  const [amount, setAmount] = useState("50000");
  const [spread, setSpread] = useState("");
  const shares = useAsync(() => strategyShares(bank.address, deployment.yieldVault), [bank.address, version, tx.ok]);
  const fees = useAsync(() => stewardFees(bank.address), [bank.address, version, tx.ok]);
  const spreadBps = useAsync(() => stewardSpreadBps(bank.address), [bank.address, version, tx.ok]);

  async function allocate() {
    await tx.run(async () => {
      const amt = toUsdc(amount || "0");
      await ledger.requestApproval(clearSign.allocate(bank.address, deployment.yieldVault, amt));
      await allocateToStrategy(wallet.walletClient!, bank.address, deployment.yieldVault, amt);
    }, "Allocated to yield ✓");
    shares.refresh();
    onChange();
  }
  async function redeem() {
    if (!shares.data) return;
    await tx.run(async () => {
      await ledger.requestApproval(clearSign.redeem(bank.address, deployment.yieldVault, shares.data!, bank.strategyAssets));
      await redeemFromStrategy(wallet.walletClient!, bank.address, deployment.yieldVault, shares.data!);
    }, "Redeemed from yield ✓");
    shares.refresh();
    onChange();
  }
  async function harvest() {
    await tx.run(async () => {
      await ledger.requestApproval(clearSign.harvest(bank.address, deployment.yieldVault));
      await harvestYield(wallet.walletClient!, bank.address, deployment.yieldVault);
    }, "Yield harvested → distributed to depositors ✓");
    onChange();
  }
  async function saveSpread() {
    const bps = Math.round(Number(spread) * 100);
    await tx.run(async () => {
      await ledger.requestApproval(clearSign.setStewardSpread(bank.address, bps));
      await setStewardSpread(wallet.walletClient!, bank.address, bps);
    }, "Spread updated ✓");
  }
  async function claimFees() {
    await tx.run(async () => {
      await ledger.requestApproval(clearSign.claimStewardFees(bank.address, fees.data ?? 0n));
      await claimStewardFees(wallet.walletClient!, bank.address);
    }, "Fees claimed ✓");
    onChange();
  }

  return (
    <Section title="Treasury yield" icon="📈" action={<Badge>guard-railed</Badge>}>
      <div className="kv"><span className="k">Idle reserve</span><span className="val"><Money v={bank.idleLiquidity} /></span></div>
      <div className="kv"><span className="k">In strategies</span><span className="val"><Money v={bank.strategyAssets} /></span></div>
      <div className="kv"><span className="k">Vault shares held</span><span className="val">{shares.data !== undefined ? fromUsdc(shares.data) : "…"}</span></div>
      <div className="inline-input" style={{marginTop: 8}}>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} />
        <TxButton onClick={allocate} className="btn primary" pending={tx.pending} disabled={!bank.products.yield}>Allocate</TxButton>
        <TxButton onClick={redeem} className="btn" pending={tx.pending} disabled={!shares.data}>Redeem all</TxButton>
      </div>

      <div className="sep" />
      <div className="lbl muted" style={{fontSize: 13}}>Yield-bearing deposits</div>
      <div className="kv"><span className="k">Steward spread</span><span className="val">{spreadBps.data !== undefined ? `${spreadBps.data / 100}%` : "…"}</span></div>
      <div className="kv"><span className="k">Your accrued fees</span><span className="val">{fees.data !== undefined ? <Money v={fees.data} /> : "…"}</span></div>
      <div className="inline-input" style={{marginTop: 8}}>
        <input placeholder="spread %" value={spread} onChange={(e) => setSpread(e.target.value)} />
        <TxButton onClick={saveSpread} className="btn" pending={tx.pending} disabled={!spread}>Set spread</TxButton>
      </div>
      <div className="row" style={{gap: 8, marginTop: 8}}>
        <TxButton onClick={harvest} className="btn primary" pending={tx.pending} disabled={!shares.data}>Harvest → depositors</TxButton>
        <TxButton onClick={claimFees} className="btn" pending={tx.pending} disabled={!fees.data}>Claim fees</TxButton>
      </div>
      <div className="hint" style={{marginTop: 6}}>
        Harvest skims only the yield (principal stays deployed), takes your spread, and distributes the rest pro-rata to depositors.
      </div>
      {tx.error && <Notice tone="err">{tx.error}</Notice>}
      {tx.ok && <Notice tone="ok">{tx.ok}</Notice>}
    </Section>
  );
}

function ControlsCard({bank, onChange}: {bank: BankInfo; onChange: () => void}) {
  const wallet = useWallet();
  const tx = useTx();
  const ledger = useLedger();
  const [products, setProducts] = useState<Products>(bank.products);
  const dirty = products.checking !== bank.products.checking || products.yield !== bank.products.yield || products.credit !== bank.products.credit;

  return (
    <Section title="Controls" icon="⚙️">
      <div className="row between" style={{marginBottom: 6}}>
        <Toggle on={ledger.enabled} onChange={ledger.setEnabled} label="Ledger-secured steward" />
        <Badge tone={ledger.enabled ? "green" : "default"}>{ledger.enabled ? "device required" : "off"}</Badge>
      </div>
      <div className="hint" style={{marginBottom: 12}}>
        When on, high-risk actions (credit, treasury, pause) require Clear-Signing approval on a Ledger device.
      </div>
      <div className="sep" />
      <div className="lbl muted" style={{fontSize: 13, marginBottom: 4}}>Products</div>
      <Toggle on={products.checking} onChange={(v) => setProducts({...products, checking: v})} label="Private checking" />
      <Toggle on={products.yield} onChange={(v) => setProducts({...products, yield: v})} label="Treasury yield" />
      <Toggle on={products.credit} onChange={(v) => setProducts({...products, credit: v})} label="Credit lines" />
      {dirty && (
        <TxButton
          onClick={() => tx.run(() => configureProducts(wallet.walletClient!, bank.address, products), "Products updated ✓").then(onChange)}
          className="btn primary sm"
          pending={tx.pending}
        >
          Save products
        </TxButton>
      )}
      <div className="sep" />
      <div className="kv"><span className="k">Global deposit cap</span><span className="val">{fromUsdc(bank.risk.globalDepositCap)}</span></div>
      <div className="kv"><span className="k">Max deposit / member</span><span className="val">{fromUsdc(bank.risk.maxDepositPerMember)}</span></div>
      <div className="kv"><span className="k">Max utilization</span><span className="val">{bank.risk.maxUtilizationBps / 100}%</span></div>
      <div className="kv"><span className="k">Withdrawal delay</span><span className="val">{bank.risk.withdrawalDelay}s</span></div>
      <div className="row" style={{gap: 8, marginTop: 14}}>
        <TxButton
          onClick={() =>
            tx
              .run(async () => {
                await ledger.requestApproval(clearSign.pause(bank.address, !bank.paused));
                await setPaused(wallet.walletClient!, bank.address, !bank.paused);
              }, bank.paused ? "Resumed ✓" : "Paused ✓")
              .then(onChange)
          }
          className={bank.paused ? "btn primary" : "btn danger"}
          pending={tx.pending}
        >
          {bank.paused ? "Resume bank" : "Emergency pause"}
        </TxButton>
      </div>
      {tx.error && <Notice tone="err">{tx.error}</Notice>}
      {tx.ok && <Notice tone="ok">{tx.ok}</Notice>}
    </Section>
  );
}

function LifiCard({bank}: {bank: BankInfo}) {
  const wallet = useWallet();
  const [amount, setAmount] = useState("10000");
  const [quote, setQuote] = useState<LifiQuote | null>(null);
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [err, setErr] = useState<string>();
  const [ok, setOk] = useState<string>();

  async function fetchQuote() {
    setLoading(true);
    setErr(undefined);
    setOk(undefined);
    setQuote(null);
    const from = wallet.address ?? bank.address;
    const r = await getLifiQuote({
      fromChain: CHAIN_ID,
      toChain: CHAIN_ID,
      fromToken: ARC_USDC_ERC20,
      toToken: ARC_EURC,
      fromAddress: from,
      amount: toUsdc(amount || "0"),
    });
    if (r.ok) setQuote(r.value);
    else setErr(r.error);
    setLoading(false);
  }

  async function execute() {
    if (!quote || !wallet.walletClient) return;
    setExecuting(true);
    setErr(undefined);
    setOk(undefined);
    const r = await executeLifiRoute(wallet.walletClient, quote);
    if (r.ok) setOk(`Route executed — ${r.value.slice(0, 12)}…`);
    else setErr(r.error);
    setExecuting(false);
  }

  return (
    <Section title="LI.FI treasury route" icon="🛣️" action={<Badge tone="amber">stretch</Badge>}>
      <p className="muted" style={{marginTop: 0}}>
        Fetch an executable same-chain swap (USDC→EURC) and, with the flag on, sign + broadcast it from
        the connected steward wallet to rebalance idle reserve. LI.FI now also routes into Robinhood
        Chain — cross-chain execution requires a wallet on the route's source chain (see ADR-001).
      </p>
      <div className="inline-input">
        <input value={amount} onChange={(e) => setAmount(e.target.value)} />
        <button className="btn primary" onClick={fetchQuote} disabled={loading}>{loading ? "…" : "Get route"}</button>
      </div>
      {quote && (
        <div className="card" style={{marginTop: 12, background: "var(--bg-elev)"}}>
          <div className="kv"><span className="k">Tool</span><span className="val">{quote.tool}</span></div>
          <div className="kv"><span className="k">Est. out (EURC)</span><span className="val">{fromUsdc(BigInt(quote.toAmount))}</span></div>
          <div className="kv"><span className="k">Router</span><span className="val">{quote.to.slice(0, 12)}…</span></div>
          <button
            className="btn primary block"
            style={{marginTop: 10}}
            onClick={execute}
            disabled={executing || !wallet.walletClient}
          >
            {executing ? "Executing…" : "Execute route"}
          </button>
        </div>
      )}
      {ok && <Notice tone="ok">{ok}</Notice>}
      {err && <Notice tone="info">{err}</Notice>}
    </Section>
  );
}
