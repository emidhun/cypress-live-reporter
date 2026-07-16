'use strict';

// All-green suite — exercises test:start / test:attempt:end / spec:end.

function login() {
  cy.get('[data-cy=login-email]').type('demo@example.com');
  cy.get('[data-cy=login-password]').type('secret123');
  cy.get('[data-cy=login-submit]').click();
  cy.get('[data-cy=todo-app]').should('be.visible');
}

describe('todos', () => {
  beforeEach(() => {
    cy.visit('/');
    login();
  });

  it('adds a task', () => {
    cy.get('[data-cy=new-todo]').type('write dashboard queries{enter}');
    cy.get('[data-cy=todo-item]').should('have.length', 1).and('contain', 'write dashboard queries');
    cy.get('[data-cy=open-count]').should('have.text', '1');
  });

  it('completes a task', () => {
    cy.get('[data-cy=new-todo]').type('ship the reporter{enter}');
    cy.get('[data-cy=todo-toggle]').check();
    cy.get('[data-cy=todo-item]').should('have.class', 'completed');
    cy.get('[data-cy=open-count]').should('have.text', '0');
  });

  it('keeps the open counter accurate across several tasks', () => {
    ['one', 'two', 'three'].forEach((t) => cy.get('[data-cy=new-todo]').type(`${t}{enter}`));
    cy.get('[data-cy=todo-item]').should('have.length', 3);
    cy.get('[data-cy=todo-toggle]').first().check();
    cy.get('[data-cy=open-count]').should('have.text', '2');
  });

  // 10 duplicated it-blocks to stress the live feed. Titles are numbered on
  // purpose: testId is the full title chain, so identical titles would
  // collapse into one row in clr_tests_live.
  for (let i = 1; i <= 10; i++) {
    it(`adds a task (copy ${i} of 10)`, () => {
      cy.get('[data-cy=new-todo]').type(`stress task ${i}{enter}`);
      cy.get('[data-cy=todo-item]').should('have.length', 1).and('contain', `stress task ${i}`);
      cy.get('[data-cy=open-count]').should('have.text', '1');
    });
  }

  it('FLAKY ON PURPOSE: fails attempt 1, passes on retry', () => {
    if (Cypress.currentRetry === 0) {
      // only the first attempt looks for an element that doesn't exist —
      // the dashboard shows this test as "retrying", then "passed"
      cy.get('[data-cy=does-not-exist]', { timeout: 500 }).should('exist');
    }
    cy.get('[data-cy=todo-app]').should('be.visible');
  });
});
