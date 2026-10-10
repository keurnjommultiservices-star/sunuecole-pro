// Habilitations : le Directeur choisit, pour chaque utilisateur, ce qu'il peut faire.
// Le rôle sert de modèle de départ ; les permissions sont ensuite modifiables une par une.
const CATALOG = [
  { key: 'dashboard.voir', label: 'Voir le tableau de bord', group: 'Général' },
  { key: 'eleves.voir', label: 'Consulter les élèves', group: 'Élèves' },
  { key: 'eleves.gerer', label: 'Inscrire / modifier les élèves', group: 'Élèves' },
  { key: 'classes.voir', label: 'Consulter les classes et matières', group: 'Classes' },
  { key: 'classes.gerer', label: 'Créer / modifier les classes', group: 'Classes' },
  { key: 'notes.saisir', label: 'Saisir les notes de ses matières', group: 'Notes' },
  { key: 'notes.toutes', label: 'Saisir/corriger les notes de toutes les matières', group: 'Notes' },
  { key: 'bulletins.voir', label: 'Consulter et imprimer les bulletins', group: 'Notes' },
  { key: 'caisse.voir', label: 'Consulter le journal des paiements', group: 'Finances' },
  { key: 'caisse.encaisser', label: 'Encaisser des paiements', group: 'Finances' },
  { key: 'impayes.voir', label: 'Consulter les impayés', group: 'Finances' }
];
const ALL = CATALOG.map(p => p.key);

const ROLES = {
  direction: { label: 'Direction', perms: ALL },
  secretariat: { label: 'Secrétariat', perms: ['dashboard.voir', 'eleves.voir', 'eleves.gerer', 'classes.voir', 'classes.gerer', 'bulletins.voir'] },
  caisse: { label: 'Caisse', perms: ['dashboard.voir', 'eleves.voir', 'caisse.voir', 'caisse.encaisser', 'impayes.voir'] },
  comptable: { label: 'Comptable', perms: ['dashboard.voir', 'caisse.voir', 'impayes.voir'] },
  enseignant: { label: 'Enseignant', perms: ['notes.saisir'] },
  autre: { label: 'Personnalisé', perms: [] }
};

const clean = list => [...new Set((Array.isArray(list) ? list : []).filter(p => ALL.includes(p)))];

module.exports = { CATALOG, ALL, ROLES, clean };
