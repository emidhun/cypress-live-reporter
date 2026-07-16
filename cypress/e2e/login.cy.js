'use strict';

// Mixed suite — the last test fails ON PURPOSE (and retries once) so the
// dashboard gets a failed test, a screenshot, a DOM snapshot, and — with
// dom.backtrackDepth > 0 — backtrack snapshots.

describe('login', () => {
  beforeEach(() => {
    cy.visit('/');
  });

  it('logs in with valid credentials', () => {
    cy.get('[data-cy=login-email]').type('demo@example.com');
    cy.get('[data-cy=login-password]').type('secret123');
    cy.get('[data-cy=login-submit]').click();
    cy.get('[data-cy=todo-app]').should('be.visible');
    cy.get('[data-cy=login-card]').should('not.be.visible');
  });

  it('shows an error on bad password', () => {
    cy.get('[data-cy=login-email]').type('demo@example.com');
    cy.get('[data-cy=login-password]').type('wrong-password');
    cy.get('[data-cy=login-submit]').click();
    cy.get('[data-cy=login-error]').should('be.visible');
    cy.get('[data-cy=todo-app]').should('not.be.visible');
  });

  it('INTENTIONAL FAILURE: error banner names the field (demo of failure evidence)', () => {
    cy.get('[data-cy=login-email]').type('demo@example.com');
    cy.get('[data-cy=login-password]').type('wrong-password');
    cy.get('[data-cy=login-submit]').click();
    // the real banner says "Invalid email or password." — this assertion is
    // wrong on purpose, fails both attempts, and produces the artifacts
    cy.get('[data-cy=login-error]', { timeout: 1500 }).should('contain', 'password must be 12 characters');
  });
});
