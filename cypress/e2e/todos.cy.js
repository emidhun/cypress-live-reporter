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
});
