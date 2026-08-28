import * as vscode from 'vscode';
import { Logger } from '../logger';

export const COMMAND_IDS = [
  // notes
  'redline.createNote',
  'redline.quickAddNote',
  'redline.editComment',
  'redline.saveComment',
  'redline.cancelEdit',
  'redline.cancelReply',
  'redline.addFollowUp',
  'redline.replyToNote',
  'redline.deleteNote',
  'redline.setKind',
  'redline.kindChange',
  'redline.kindBug',
  'redline.kindSecurity',
  'redline.kindPerf',
  'redline.kindIdea',
  'redline.kindRefactor',
  'redline.kindQuestion',
  'redline.kindTodo',
  'redline.kindNit',
  'redline.kindPraise',
  'redline.addSuggestion',
  'redline.applySuggestion',
  'redline.toggleDone',
  'redline.revealNote',
  'redline.reanchorNote',
  'redline.reviseNote',
  // batch / agent
  'redline.submit',
  'redline.sendSelected',
  'redline.previewBatch',
  'redline.copyNote',
  'redline.applyReport',
  'redline.clearSent',
  'redline.clearAll',
  'redline.restoreLastBatch',
  'redline.pickSession',
  // changes
  'redline.reviewChanges',
  'redline.reviewAllChanges',
  'redline.nextChange',
  'redline.prevChange',
  'redline.markBaseline',
  'redline.clearBaseline',
  // misc
  'redline.refresh',
  'redline.focusPanel',
  'redline.showLog',
  'redline.followUpHere',
  'redline.reviewPreviousRun',
  'redline.setUpHook',
] as const;

export type CommandId = (typeof COMMAND_IDS)[number];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CommandHandler = (...args: any[]) => unknown | Promise<unknown>;

export type CommandMap = Record<CommandId, CommandHandler>;

/**
 * Registers every command id exactly once, wrapping each handler so a thrown error is
 * logged and surfaced as one warning toast rather than an unhandled rejection.
 */
export function registerAllCommands(
  context: vscode.ExtensionContext,
  logger: Logger,
  handlers: CommandMap,
): void {
  for (const id of COMMAND_IDS) {
    const handler = handlers[id];
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          logger.trace(`command ${id}`);
          return await handler(...args);
        } catch (err) {
          await logger.reportError(`${id} failed`, err);
          return undefined;
        }
      }),
    );
  }
}
