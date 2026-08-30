/**
 * examples/github-pr-review-swarm.js
 * 
 * Real-World Multi-Agent GitHub PR Review Swarm
 * 
 * Simulates a continuous multi-agent code review pipeline:
 * 1. PR Diff submitted for review.
 * 2. Security Review delegated to Hermes Agent.
 * 3. Architecture & API Review delegated to OpenCode.
 * 4. Test Coverage & Edge Cases verified by Pi Coding Agent.
 * 5. Compiles comprehensive markdown PR Review for GitHub.
 */

const { wakeAgent } = require('../src/controllers/autowake');
const { sendChannelMessage, readChannel } = require('../src/core/mesh');

async function runPrReviewSwarm(prNumber = 142) {
  console.log('========================================================================');
  console.log(`🔍 [GITHUB MULTI-AGENT PR REVIEW SWARM]: Pull Request #${prNumber}`);
  console.log('========================================================================\n');

  const channel = `#pr-${prNumber}-review`;

  const prDiffSample = `
diff --git a/src/auth/jwt.js b/src/auth/jwt.js
index 4a12..9f8b 100644
--- a/src/auth/jwt.js
+++ b/src/auth/jwt.js
@@ -12,4 +12,6 @@ function verifyToken(req, res, next) {
   const token = req.headers['authorization'];
-  const decoded = jwt.verify(token, process.env.JWT_SECRET);
+  const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
   req.user = decoded;
   next();
 }
`;

  console.log('📄 [1. PR DIFF DETECTED]:');
  console.log(prDiffSample.trim() + '\n');

  // Broadcast to PR review channel
  sendChannelMessage(channel, 'github-bot', `PR #${prNumber} submitted for multi-agent review.`);

  // 1. Dispatch to Hermes for Security Inspection
  console.log('🛡️ [2. DISPATCHING TO HERMES]: Security & Cryptographic Review...');
  await new Promise(resolve => {
    wakeAgent('hermes', `Audit PR #${prNumber}: Verify JWT algorithm pinning prevents 'none' algorithm attacks.`, () => {
      sendChannelMessage(channel, 'hermes', 'Security Review: APPROVED. Algorithm is explicitly pinned to HS256, preventing header-injection vulnerabilities.');
      resolve();
    });
  });

  // 2. Dispatch to OpenCode for Contract & Typing Review
  console.log('\n💻 [3. DISPATCHING TO OPENCODE]: API Contract & Error Handling Review...');
  await new Promise(resolve => {
    wakeAgent('opencode', `Review PR #${prNumber}: Check error handling when Bearer prefix is missing in Authorization header.`, () => {
      sendChannelMessage(channel, 'opencode', 'API Review: COMMENT. Recommendation: Add token.replace(/^Bearer\\s+/, "") to support standard Authorization header formats.');
      resolve();
    });
  });

  // 3. Compile GitHub PR Review Markdown
  console.log('\n📋 [4. COMPILING SYNTHESIZED GITHUB PR REVIEW]:\n');
  const reviews = readChannel(`pr-${prNumber}-review`);
  
  const markdownReport = `
## 🤖 Multi-Agent Pull Request Review (PR #${prNumber})

| Reviewer Agent | Domain | Verdict | Notes |
| :--- | :--- | :--- | :--- |
| **Hermes Agent** | Security & Cryptography | ✅ APPROVED | Algorithm explicitly pinned to HS256. |
| **OpenCode Agent**| API Contracts & DX | 💬 COMMENT | Strip \`Bearer \` prefix in token parser. |

### Detailed Agent Feedback:
${reviews.map(r => `- **@${r.from}**: ${r.message}`).join('\n')}

---
*Generated automatically via [intercom-global](https://github.com/Suran123s/intercom-global)*
`;

  console.log(markdownReport.trim());
  console.log('\n========================================================================');
  console.log(`🎉 [PR #${prNumber} REVIEW COMPLETE]: Ready to post to GitHub PR comments!`);
  console.log('========================================================================\n');
}

if (require.main === module) {
  runPrReviewSwarm().catch(console.error);
}

module.exports = { runPrReviewSwarm };
