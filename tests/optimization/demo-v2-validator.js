/**
 * Demo: Schema v2.0 Answer Validator
 *
 * Shows the difference between v1.0 (length-only) and v2.0 (comprehensive) validation
 */

import { AnswerQualityValidator } from '../integration/answer-validator.js';

console.log('\n' + '='.repeat(80));
console.log('DEMO: Schema v2.0 Answer Validator');
console.log('Comparing v1.0 vs v2.0 Validation Quality');
console.log('='.repeat(80) + '\n');

// Initialize v2.0 validator
const validator = new AnswerQualityValidator();

// Test Case: User asks about upcoming meetings
const testCase = {
  id: 'demo-001',
  user_query: {
    natural: 'When am I meeting John?',
    variations: ['Do I have meetings with John?', 'Show me John meetings']
  },
  expected_behavior: {
    answer_requirements: {
      must_include: ['time', 'date', 'John'],
      must_not_include: ['error', 'failed'],
      tone: 'helpful_not_technical'
    },
    success_criteria: {
      task_completed: true,
      user_can_proceed: true,
      clarity_score_min: 0.8
    }
  }
};

// Example answers to test
const answers = [
  {
    label: 'Good Answer',
    text: 'You have 2 meetings with John:\n\n1. **Team Sync** - Tomorrow (Oct 10) at 2:00 PM\n2. **Project Review** - Friday (Oct 13) at 10:00 AM\n\nBoth meetings are in your Work calendar.',
    expectedResult: 'PASS'
  },
  {
    label: 'Bad Answer #1 (No time info)',
    text: 'I found some meetings with John in your calendar.',
    expectedResult: 'FAIL - Missing time/date'
  },
  {
    label: 'Bad Answer #2 (Technical jargon)',
    text: 'Query returned 2 VEVENT objects with ATTENDEE property matching "John". Exception: null pointer in timezone field.',
    expectedResult: 'FAIL - Technical tone'
  },
  {
    label: 'Bad Answer #3 (Too short)',
    text: 'Yes.',
    expectedResult: 'FAIL - No content'
  }
];

// Test each answer
for (const answer of answers) {
  console.log('─'.repeat(80));
  console.log(`📝 ${answer.label}`);
  console.log('─'.repeat(80));
  console.log(`Answer: "${answer.text}"\n`);

  // V1.0 Validation (old way - length only)
  const v1Validation = validateV1(answer.text);

  // V2.0 Validation (new way - comprehensive)
  const v2Validation = validator.validateAnswerCompleteness(
    answer.text,
    testCase.user_query.natural,
    testCase
  );

  // Compare results
  console.log('V1.0 Validation (old):');
  console.log(`  Result: ${v1Validation.passed ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`  Score: ${v1Validation.score}`);
  console.log(`  Feedback: ${v1Validation.feedback.join(', ') || 'None'}`);
  console.log('');

  console.log('V2.0 Validation (new):');
  console.log(`  Result: ${v2Validation.passed ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`  Score: ${v2Validation.score.toFixed(2)}`);
  console.log(`  Detailed Feedback:`);
  if (v2Validation.feedback.length === 0) {
    console.log('    ✅ All checks passed!');
  } else {
    v2Validation.feedback.forEach(fb => console.log(`    ${fb}`));
  }
  console.log('');

  console.log('V2.0 Detailed Checks:');
  console.log(`  ✓ Has content: ${v2Validation.checks.has_content.passed ? '✅' : '❌'} (${v2Validation.checks.has_content.word_count} words)`);
  console.log(`  ✓ Answers question: ${v2Validation.checks.answers_question.passed ? '✅' : '❌'} (intent: ${v2Validation.checks.answers_question.intent})`);
  console.log(`  ✓ Required data: ${v2Validation.checks.includes_required_data.passed ? '✅' : '❌'} (${v2Validation.checks.includes_required_data.found?.length || 0}/${testCase.expected_behavior.answer_requirements.must_include.length})`);
  console.log(`  ✓ No forbidden: ${v2Validation.checks.excludes_forbidden.passed ? '✅' : '❌'}`);
  console.log(`  ✓ Actionable: ${v2Validation.checks.has_actionable_next_steps.passed ? '✅' : '❌'} (${v2Validation.checks.has_actionable_next_steps.is_error ? 'error detected' : 'no error'})`);
  console.log(`  ✓ Tone: ${v2Validation.checks.tone_appropriate.passed ? '✅' : '❌'}`);
  console.log('');

  console.log(`Expected: ${answer.expectedResult}`);
  console.log('');
}

console.log('='.repeat(80));
console.log('SUMMARY: V2.0 catches issues that V1.0 misses!');
console.log('='.repeat(80));
console.log('✅ V2.0 provides actionable feedback for debugging');
console.log('✅ V2.0 validates semantic completeness, not just length');
console.log('✅ V2.0 detects tone issues (technical jargon)');
console.log('✅ V2.0 checks if answer actually addresses user intent');
console.log('='.repeat(80) + '\n');

/**
 * V1.0 validation (old way - length only)
 */
function validateV1(answer) {
  const minLength = 10;
  const hasContent = answer.trim().length >= minLength;
  const notErrorMessage = !answer.toLowerCase().includes('error') &&
                         !answer.toLowerCase().includes('failed');

  const passed = hasContent && notErrorMessage;
  return {
    passed: passed,
    score: passed ? 1.0 : 0.0,
    feedback: passed ? [] : ['Answer too short or contains error']
  };
}
