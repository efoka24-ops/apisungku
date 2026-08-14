-- Texte affiche au payeur sur l'invite de saisie du code PIN.
-- Colonne nullable : les transactions existantes restent valides, et la
-- migration s'applique sans verrouiller la table.
ALTER TABLE "transactions" ADD COLUMN "customerMessage" TEXT;
