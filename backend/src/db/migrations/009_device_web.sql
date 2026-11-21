-- v49: the website (PWA) signs in too. The devices.platform CHECK only knew
-- the two mobile platforms; browsers that receive alerts through Web Push
-- are a third kind of device. Same table shape otherwise.
ALTER TABLE devices DROP CONSTRAINT devices_platform_check;
ALTER TABLE devices ADD CONSTRAINT devices_platform_check CHECK (platform IN ('android','ios','web'));
