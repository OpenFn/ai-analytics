const RECIPIENTS = [
  'joe@openfn.org',
  'hanna@openfn.org'
];

fn((state) => {
  const { summaryText, dateRangeLabel } = state;
  if (!summaryText) {
    console.log('No summaryText in state — nothing to send.');
    return state;
  }
  return { ...state, RECIPIENTS, emailSubject: `AI Assistant Feedback Summary (${dateRangeLabel})`, emailBody: summaryText };
});

each($.RECIPIENTS, (state) => {
  const { emailSubject, emailBody } = state;
  return sendMessage({
    to: state.data,
    subject: emailSubject,
    body: emailBody,
  })(state);
});
