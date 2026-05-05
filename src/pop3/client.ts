import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { config } from '../config';

export interface DownloadedEmail {
  uid: number;
  senderName: string;
  receivedAt: Date;
  content: string; // text or html
}

export interface ProcessingResult {
  processed: number;
  failed: number;
  failedSenders: string[];
}

/**
 * Connects to the IMAP server, iterates over all available emails and
 * calls `processorFn` for each one.
 *
 * Safe-deletion: an email is only deleted from the IMAP server if
 * `processorFn` completes without throwing. Failed emails remain on
 * the server so they will be retried on the next run.
 */
export async function processEmails(
  processorFn: (email: DownloadedEmail) => Promise<void>
): Promise<ProcessingResult> {
  const client = new ImapFlow({
    host: config.POP3_HOST,
    port: config.POP3_PORT,
    secure: config.POP3_TLS,
    auth: {
      user: config.POP3_USERNAME,
      pass: config.POP3_PASSWORD,
    },
    logger: false,
  });

  const result: ProcessingResult = { processed: 0, failed: 0, failedSenders: [] };

  try {
    await client.connect();

    // Select the INBOX
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Search for all messages and return their UIDs
      const messages = await client.search({ all: true }, { uid: true });

      if (!messages || messages.length === 0) {
        console.log("📭 No new emails found in IMAP INBOX.");
        return result;
      }

      console.log(`📬 Found ${messages.length} email(s) to process.`);

      for (const uid of messages) {
        let senderName = `message #${uid}`;
        try {
          // Fetch raw email content
          const message = await client.fetchOne(uid.toString(), { source: true }, { uid: true });
          if (!message || !message.source) {
            throw new Error(`Failed to fetch source for UID ${uid}`);
          }

          const parsed = await simpleParser(message.source);

          senderName = parsed.from?.value[0]?.name || parsed.from?.value[0]?.address || senderName;
          const receivedAt = parsed.date || new Date();
          const content = parsed.html || parsed.text || '';

          console.log(`📧 Downloaded message ${uid} from "${senderName}".`);

          const email: DownloadedEmail = { 
            uid: Number(uid), 
            senderName, 
            receivedAt, 
            content 
          };

          // Run the caller-supplied processing logic
          await processorFn(email);

          // Only delete (move to Trash or add Deleted flag) if processing succeeded
          // In IMAP, we add the \Deleted flag and then logout/expunge
          await client.messageFlagsAdd(uid.toString(), ['\\Deleted'], { uid: true });
          console.log(`🗑️  Marked message ${uid} from "${senderName}" as deleted.`);

          result.processed++;

        } catch (err) {
          result.failed++;
          result.failedSenders.push(senderName);
          console.error(
            `❌ Failed to process message ${uid} from "${senderName}". ` +
            `Error: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    } finally {
      lock.release();
    }

    // Expunge and close connection
    await client.logout();

  } catch (err) {
    console.error(`❌ IMAP connection/session error: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }

  return result;
}
