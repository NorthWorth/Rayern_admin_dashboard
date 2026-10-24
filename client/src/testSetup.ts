import '@testing-library/jest-dom'
import { cleanup } from '@testing-library/react'
import { JSDOM } from 'jsdom'

afterEach(cleanup)

let dom: JSDOM

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'http://localhost',
  })
  global.window = dom.window as unknown as Window & typeof globalThis
  global.document = dom.window.document
})

afterAll(() => {
  dom?.window?.close()
})

beforeEach(() => {
  document.body.innerHTML = ''
})
