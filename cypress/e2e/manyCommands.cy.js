'use strict';

// Demonstrates the command log's TRUE ordinal: this test runs dozens of
// commands before the failing one, so the dashboard shows e.g. "command #42
// failed · showing last 20 of 42" — not a misleading "#20".

describe('command depth', () => {
  it('runs many commands then fails (shows the real failing command number)', () => {
    cy.visit('/');
    // pile up real commands so the failing command's ordinal is high
    for (let i = 0; i < 40; i++) {
      cy.get('[data-cy=login-card]');
    }
    // this one fails — its ordinal should be ~42, not ~20
    cy.get('[data-cy=does-not-exist]', { timeout: 500 }).should('exist');
  });
});
