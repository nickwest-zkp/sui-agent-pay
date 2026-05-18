import * as fs from "fs";
import * as path from "path";
import type { AgentConfig, AgentPolicy, ApprovalRequest, AuditReceipt, BudgetRecord, PaidService, TelegramBinding } from "../types";

type StorageMode = "json";

type JsonState = {
  agents: AgentConfig[];
  policies: AgentPolicy[];
  receipts: AuditReceipt[];
  budgets: BudgetRecord[];
  services: PaidService[];
  approvals: ApprovalRequest[];
  telegramBindings: TelegramBinding[];
};

function currentDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createEmptyState(): JsonState {
  return {
    agents: [],
    policies: [],
    receipts: [],
    budgets: [],
    services: [],
    approvals: [],
    telegramBindings: [],
  };
}

export class Storage {
  private readonly filePath: string;
  private readonly mode: StorageMode;
  private state: JsonState;

  constructor(dbPath: string) {
    const parsed = path.parse(dbPath);
    this.filePath = path.join(parsed.dir, `${parsed.name}.json`);
    this.mode = "json";

    const parent = path.dirname(this.filePath);
    if (parent && parent !== ".") {
      fs.mkdirSync(parent, { recursive: true });
    }

    this.state = this.readState();
    this.flush();
  }

  private readState(): JsonState {
    if (!fs.existsSync(this.filePath)) {
      return createEmptyState();
    }

    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      if (!raw.trim()) {
        return createEmptyState();
      }

      const parsed = JSON.parse(raw) as Partial<JsonState>;
      return {
        agents: Array.isArray(parsed.agents) ? parsed.agents : [],
        policies: Array.isArray(parsed.policies) ? parsed.policies : [],
        receipts: Array.isArray(parsed.receipts) ? parsed.receipts : [],
        budgets: Array.isArray(parsed.budgets) ? parsed.budgets : [],
        services: Array.isArray(parsed.services) ? parsed.services : [],
        approvals: Array.isArray(parsed.approvals) ? parsed.approvals : [],
        telegramBindings: Array.isArray(parsed.telegramBindings) ? parsed.telegramBindings : [],
      };
    } catch {
      return createEmptyState();
    }
  }

  private flush(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
  }

  saveAgent(agent: AgentConfig): void {
    this.state.agents = [
      clone(agent),
      ...this.state.agents.filter(item => item.agentId !== agent.agentId),
    ];
    this.flush();
  }

  markAgentRevoked(agentId: string, revokedAt: string): void {
    this.state.agents = this.state.agents.map(agent =>
      agent.agentId === agentId ? { ...agent, revokedAt } : agent,
    );
    this.flush();
  }

  getAgent(agentId: string): AgentConfig | null {
    const found = this.state.agents.find(agent => agent.agentId === agentId);
    return found ? clone(found) : null;
  }

  listAgents(): AgentConfig[] {
    return clone(
      [...this.state.agents].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    );
  }

  savePolicy(policy: AgentPolicy): void {
    this.state.policies = [
      clone(policy),
      ...this.state.policies.filter(item => item.agentId !== policy.agentId),
    ];
    this.flush();
  }

  getPolicy(agentId: string): AgentPolicy | null {
    const found = this.state.policies.find(policy => policy.agentId === agentId);
    return found ? clone(found) : null;
  }

  saveReceipt(receipt: AuditReceipt): void {
    this.state.receipts = [
      clone(receipt),
      ...this.state.receipts.filter(item => item.paymentId !== receipt.paymentId),
    ];
    this.flush();
  }

  getReceipts(agentId: string, limit = 50): AuditReceipt[] {
    return clone(
      this.state.receipts
        .filter(receipt => receipt.agentId === agentId)
        .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
        .slice(0, limit),
    );
  }

  getRecentReceipts(limit = 100): AuditReceipt[] {
    return clone(
      [...this.state.receipts]
        .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
        .slice(0, limit),
    );
  }

  getDailyBudget(agentId: string, date?: string): BudgetRecord | null {
    const current = date ?? currentDateKey();
    const found = this.state.budgets.find(budget => budget.agentId === agentId && budget.date === current);
    return found ? clone(found) : null;
  }

  incrementDailyBudget(agentId: string, amount: string): void {
    const date = currentDateKey();
    const found = this.state.budgets.find(budget => budget.agentId === agentId && budget.date === date);

    if (found) {
      found.dailySpent = (BigInt(found.dailySpent) + BigInt(amount)).toString();
      found.txCount += 1;
    } else {
      this.state.budgets.unshift({
        agentId,
        date,
        dailySpent: amount,
        txCount: 1,
      });
    }

    this.flush();
  }

  saveService(service: PaidService): void {
    this.state.services = [
      clone(service),
      ...this.state.services.filter(item => item.serviceId !== service.serviceId),
    ];
    this.flush();
  }

  getService(serviceId: string): PaidService | null {
    const found = this.state.services.find(service => service.serviceId === serviceId);
    return found ? clone(found) : null;
  }

  listServices(): PaidService[] {
    return clone(
      [...this.state.services].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    );
  }

  deleteService(serviceId: string): boolean {
    const before = this.state.services.length;
    this.state.services = this.state.services.filter(service => service.serviceId !== serviceId);
    const changed = this.state.services.length !== before;
    if (changed) {
      this.flush();
    }
    return changed;
  }

  saveApprovalRequest(request: ApprovalRequest): void {
    this.state.approvals = [
      clone(request),
      ...this.state.approvals.filter(item => item.approvalId !== request.approvalId),
    ];
    this.flush();
  }

  getApprovalRequest(approvalId: string): ApprovalRequest | null {
    const found = this.state.approvals.find(request => request.approvalId === approvalId);
    return found ? clone(found) : null;
  }

  getApprovalRequestByToken(approvalToken: string): ApprovalRequest | null {
    const found = this.state.approvals.find(request => request.approvalToken === approvalToken);
    return found ? clone(found) : null;
  }

  listApprovalRequests(limit = 50): ApprovalRequest[] {
    return clone(
      [...this.state.approvals]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, limit),
    );
  }

  updateApprovalRequest(approvalId: string, patch: Partial<ApprovalRequest>): ApprovalRequest | null {
    const index = this.state.approvals.findIndex(request => request.approvalId === approvalId);
    if (index === -1) {
      return null;
    }

    const current = this.state.approvals[index];
    const next: ApprovalRequest = {
      ...current,
      ...clone(patch),
      approvalId: current.approvalId,
      approvalToken: current.approvalToken,
    };

    this.state.approvals[index] = next;
    this.flush();
    return clone(next);
  }

  saveTelegramBinding(binding: TelegramBinding): void {
    const normalizedWalletAddress = binding.walletAddress.toLowerCase();
    this.state.telegramBindings = [
      clone({ ...binding, walletAddress: normalizedWalletAddress }),
      ...this.state.telegramBindings.filter(item => item.walletAddress.toLowerCase() !== normalizedWalletAddress),
    ];
    this.flush();
  }

  getTelegramBindingByWalletAddress(walletAddress: string): TelegramBinding | null {
    const normalizedWalletAddress = walletAddress.toLowerCase();
    const found = this.state.telegramBindings.find(binding => binding.walletAddress.toLowerCase() === normalizedWalletAddress);
    return found ? clone(found) : null;
  }

  listTelegramBindings(): TelegramBinding[] {
    return clone(
      [...this.state.telegramBindings].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    );
  }

  deleteTelegramBinding(walletAddress: string): boolean {
    const normalizedWalletAddress = walletAddress.toLowerCase();
    const before = this.state.telegramBindings.length;
    this.state.telegramBindings = this.state.telegramBindings.filter(
      binding => binding.walletAddress.toLowerCase() !== normalizedWalletAddress,
    );
    const changed = this.state.telegramBindings.length !== before;
    if (changed) {
      this.flush();
    }
    return changed;
  }

  close(): void {}

  get storageMode(): StorageMode {
    return this.mode;
  }
}
