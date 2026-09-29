'use strict';
const express = require('express');
const { AdminAuth, requireAdmin } = require('../auth/adminAuth');
const { ConfigStore } = require('../config/configStore');

function createAdminRoutes(configStore, adminAuth) {
  const store = configStore || new ConfigStore();
  const auth = adminAuth || new AdminAuth();
  const router = express.Router();
  router.use(express.json());

  router.post('/login', (req, res) => {
    const { password } = req.body || {};
    const token = auth.login(password);
    if (!token) return res.status(401).json({ error: 'wrong-password' });
    res.json({ token });
  });
  router.get('/config', requireAdmin(auth), (req, res) => res.json(store.getAll()));
  router.patch('/config/:section', requireAdmin(auth), (req, res) => {
    try { res.json(store.patchSection(req.params.section, req.body)); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  router.post('/config/:section/reset', requireAdmin(auth), (req, res) => {
    try { res.json(store.resetSection(req.params.section)); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  return { router, store, auth };
}
module.exports = { createAdminRoutes };
