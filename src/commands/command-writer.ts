import { writeFile, readFile, rename, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Writes each batch to its own file, executed manually with the returned `run` command.
 *
 * The file is placed in the Stellaris documents root directory.
 * The file is not an execution acknowledgement; rerunning a batch repeats its actions.
 */
export class CommandWriter {
  private commandFile: string | null = null;
  private pendingCommands: { command: string }[] = [];
  private flushChain: Promise<void> = Promise.resolve();

  constructor(private stellarisDocumentsPath: string) {
  }

  /**
   * Queue a raw console command
   */
  queueCommand(command: string): void {
    this.pendingCommands.push({ command });
  }

  /**
   * Queue an effect command (wraps in `effect { ... }`)
   */
  queueEffect(effect: string): void {
    this.queueCommand(`effect ${effect}`);
  }

  /**
   * Queue a resource command
   */
  queueAddResource(resource: string, amount: number): void {
    this.queueCommand(`${resource} ${amount}`);
  }

  /**
   * Queue a technology research command
   */
  queueResearchTech(techId: string): void {
    this.queueCommand(`research_technology ${techId}`);
  }

  /**
   * Queue a planet building command via effect
   */
  queueBuildOnPlanet(planetId: number, buildingId: string): void {
    this.queueEffect(
      `event_target:planet_${planetId} = { add_building = ${buildingId} }`
    );
  }

  /**
   * Queue a fleet move command
   */
  queueMoveFleet(fleetId: number, systemId: number): void {
    this.queueEffect(
      `fleet = { id = ${fleetId} queue_actions = { move_to = { target = galactic_object:${systemId} } } }`
    );
  }

  /**
   * Queue a policy change
   */
  queueSetPolicy(policyId: string, optionId: string): void {
    this.queueEffect(
      `set_policy = { policy = ${policyId} option = ${optionId} cooldown = yes }`
    );
  }

  /**
   * Queue a diplomatic action
   */
  queueDiplomaticAction(action: string, targetCountryId: number): void {
    this.queueEffect(
      `country:${targetCountryId} = { ${action} = root }`
    );
  }

  /**
   * Write all pending commands to the file and clear the queue
   */
  async flush(): Promise<string> {
    const result = this.flushChain.then(() => this.flushBatch());
    this.flushChain = result.then(() => undefined, () => undefined);
    return result;
  }

  private async flushBatch(): Promise<string> {
    if (this.pendingCommands.length === 0) {
      return "No pending commands";
    }

    const batch = [...this.pendingCommands];
    const commandFile = join(this.stellarisDocumentsPath, `ai_commands_${randomUUID()}.txt`);
    const temporaryFile = `${commandFile}.tmp`;
    const content = batch.map(({ command }) => command).join("\n") + "\n";
    try {
      await writeFile(temporaryFile, content, { encoding: "utf-8", flag: "wx" });
      await rename(temporaryFile, commandFile);
    } catch (error) {
      await unlink(temporaryFile).catch(() => undefined);
      // Keep the batch queued for a retry; no partial final file is visible.
      throw new Error(`Cannot write Stellaris command batch to ${commandFile}`, { cause: error });
    }
    const written = new Set(batch);
    this.pendingCommands = this.pendingCommands.filter((entry) => !written.has(entry));
    this.commandFile = commandFile;
    return `Wrote ${batch.length} commands to ${commandFile}. Execute in Stellaris console: run ${basename(commandFile)}. This file has not been executed automatically.`;
  }

  /**
   * Read current pending commands
   */
  getPendingCommands(): string[] {
    return this.pendingCommands.map(({ command }) => command);
  }

  /**
   * Clear pending commands without writing
   */
  clearPending(): void {
    this.pendingCommands = [];
  }

  /**
   * Read the current command file content
   */
  async readCommandFile(): Promise<string> {
    if (!this.commandFile) return "";
    try {
      return await readFile(this.commandFile, "utf-8");
    } catch {
      return "";
    }
  }
}
