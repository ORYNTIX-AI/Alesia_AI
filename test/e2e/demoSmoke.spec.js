import { expect, test } from '@playwright/test'

test('demo shell opens settings and tester drawer', async ({ page }) => {
  await page.goto('/')

  await expect(page.locator('.primary-button').first()).toBeVisible({ timeout: 30_000 })

  await page.getByRole('button', { name: 'Открыть настройки персонажа' }).click()
  await expect(page.locator('.settings-drawer')).toBeVisible()
  await page.locator('.settings-drawer__close').click()

  await page.locator('.tester-drawer__handle').click()
  await expect(page.locator('#tester-drawer')).toHaveClass(/is-open/)
  await expect(page.locator('.tester-status-grid')).toBeVisible()
})
