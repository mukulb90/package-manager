const db = require('../util/pghelper');
const push = require('../worker/packagepush');
const admin = require('./admin');
const logger = require('../util/logger').logger;
const orgpackageversions = require('./orgpackageversions');

const State = {
	Ready: "Ready",
	Blocked: "Blocked",
	Running: "Running",
	Partial: "Partial",
	Complete: "Complete"
};

const UpgradeStatus = {
	Ready: "Ready",
	Active: "Active",
	Done: "Done",
	Canceled: "Canceled",
	Failed: "Failed"
};

const MAX_ERROR_COUNT = 20;

const ITEM_STATUS_SOQL = `
	CASE
		 WHEN -- ALL Created == Inactive
           count(i.*) = 0 THEN 'Invalid'
	     WHEN -- ALL Created == Inactive
         count(CASE 
                      WHEN i.status = 'Created' THEN 1
                      ELSE NULL END) = count(i.*) THEN 'Scheduled'
         WHEN -- At least one canceled == Canceled
         count(CASE 
                      WHEN i.status = 'Canceled' THEN 1
                      ELSE NULL END) > 0 THEN 'Canceled'
         WHEN -- At least one create, pending or in progress == Active
         count(CASE 
                      WHEN i.status = 'Created' THEN 1
                      WHEN i.status = 'Pending' THEN 1
                      WHEN i.status = 'InProgress' THEN 1
                      ELSE NULL END) > 0 THEN 'Active'
         WHEN -- At least one failed or ineligible == Failed
         count(CASE 
                      WHEN i.status = 'Failed' THEN 1
                      WHEN i.status = 'Ineligible' THEN 1
                      ELSE NULL END) > 0 THEN 'Complete with failures'
         ELSE -- All done and succeeded == Succeeded
         'Complete' 
	END item_status`;

const SELECT_ALL = `
    SELECT u.id, u.status, u.start_time, u.created_by, u.description,
    ${ITEM_STATUS_SOQL}
    FROM upgrade u
    LEFT JOIN upgrade_item i ON i.upgrade_id = u.id`;

const GROUP_BY_ALL = `GROUP BY u.id, u.start_time, u.created_by, u.description`;

const SELECT_ONE = `
    SELECT u.id, u.status, u.start_time, u.created_by, u.description,
	${ITEM_STATUS_SOQL}
    FROM upgrade u
    LEFT JOIN upgrade_item i ON i.upgrade_id = u.id
    WHERE u.id = $1
    GROUP by u.id, u.start_time, u.created_by, u.description`;

const SELECT_ALL_ITEMS = `SELECT i.id, i.upgrade_id, i.push_request_id, i.package_org_id, i.start_time, i.status, i.created_by, i.total_job_count,
        u.description,
        pv.version_number, pv.version_id, pv.version_sort,
        p.name package_name, p.sfid package_id, p.dependency_tier,
        CAST (count(j.*) AS INTEGER) job_count, 
        CAST (count(NULLIF(j.status, 'Ineligible')) AS INTEGER) eligible_job_count,
        CAST (count(CASE
			WHEN j.status = 'Created' THEN 1
			ELSE NULL END) AS INTEGER) created_job_count,		
	  	CAST (count(CASE
			WHEN j.status = 'Failed' THEN 1
			ELSE NULL END) AS INTEGER) failed_job_count,
	  	CAST (count(CASE
			WHEN j.status = 'Invalid' THEN 1
			ELSE NULL END) AS INTEGER) invalid_job_count,
		CAST (count(CASE
			WHEN j.status = 'Canceled' THEN 1
			ELSE NULL END) AS INTEGER) canceled_job_count,
		CAST (count(CASE
			WHEN j.status = 'Pending' THEN 1
			ELSE NULL END) AS INTEGER) pending_job_count,
		CAST (count(CASE
			WHEN j.status = 'InProgress' THEN 1
			ELSE NULL END) AS INTEGER) inprogress_job_count,
		CAST (count(CASE
			WHEN j.status = 'Succeeded' THEN 1
			ELSE NULL END) AS INTEGER) succeeded_job_count
        FROM upgrade_item i
        inner join upgrade u on u.id = i.upgrade_id
        inner join package_version pv on pv.version_id = i.version_id
        inner join package p on p.sfid = pv.package_id
        left join upgrade_job j on j.item_id = i.id`;

const GROUP_BY_ITEMS = `GROUP BY i.id, i.upgrade_id, i.push_request_id, i.package_org_id, i.start_time, i.status,
        u.description,
        pv.version_number, pv.version_id, pv.version_sort,
        p.name, p.sfid`;

const SELECT_ALL_ITEMS_BY_UPGRADE = `${SELECT_ALL_ITEMS} WHERE i.upgrade_id = $1 ${GROUP_BY_ITEMS}`;

const SELECT_ONE_ITEM = `SELECT i.id, i.upgrade_id, i.push_request_id, i.package_org_id, i.start_time, i.status, i.created_by, i.total_job_count,
        u.description,
        pv.version_number, pv.version_id,
        p.name package_name, p.dependency_tier,
                CAST (count(j.*) AS INTEGER) job_count, 
        CAST (count(NULLIF(j.status, 'Ineligible')) AS INTEGER) eligible_job_count,		
	  	CAST (count(CASE
			WHEN j.status = 'Created' THEN 1
			ELSE NULL END) AS INTEGER) created_job_count,
		CAST (count(CASE
			WHEN j.status = 'Failed' THEN 1
			ELSE NULL END) AS INTEGER) failed_job_count,
	  	CAST (count(CASE
			WHEN j.status = 'Invalid' THEN 1
			ELSE NULL END) AS INTEGER) invalid_job_count,
		CAST (count(CASE
			WHEN j.status = 'Canceled' THEN 1
			ELSE NULL END) AS INTEGER) canceled_job_count,
		CAST (count(CASE
			WHEN j.status = 'Pending' THEN 1
			ELSE NULL END) AS INTEGER) pending_job_count,
		CAST (count(CASE
			WHEN j.status = 'InProgress' THEN 1
			ELSE NULL END) AS INTEGER) inprogress_job_count,
		CAST (count(CASE
			WHEN j.status = 'Succeeded' THEN 1
			ELSE NULL END) AS INTEGER) succeeded_job_count
        FROM upgrade_item i
        INNER JOIN upgrade u on u.id = i.upgrade_id
        INNER JOIN package_version pv on pv.version_id = i.version_id
        INNER JOIN package p on p.sfid = pv.package_id
		left join upgrade_job j on j.item_id = i.id`;

const SELECT_ALL_JOBS = `SELECT j.id, j.upgrade_id, j.push_request_id, j.job_id, j.org_id, o.instance, j.status,
        i.start_time, i.created_by,
        pv.version_number, pv.version_id, pv.version_sort,
        pvc.version_number current_version_number, pvc.version_id current_version_id, pvc.version_sort current_version_sort,
        pvo.version_number original_version_number, pvo.version_id original_version_id, pvo.version_sort original_version_sort,
        p.name package_name, p.sfid package_id, p.package_org_id, p.dependency_tier,
        a.account_name,
        j.message
        FROM upgrade_job j
        INNER JOIN upgrade_item i on i.push_request_id = j.push_request_id
        INNER JOIN package_version pv on pv.version_id = i.version_id
        INNER JOIN org_package_version opv on opv.package_id = pv.package_id AND opv.org_id = j.org_id
        INNER JOIN package_version pvc on pvc.version_id = opv.version_id
        LEFT JOIN package_version pvo on pvo.version_id = j.original_version_id
        INNER JOIN package p on p.sfid = pv.package_id
        INNER JOIN org o on o.org_id = j.org_id
        INNER JOIN account a ON a.account_id = o.account_id`;

async function createUpgrade(scheduledDate, createdBy, description, blacklisted) {
	let isoTime = scheduledDate ? scheduledDate.toISOString ? scheduledDate.toISOString() : scheduledDate : null;
	let recs = await db.insert('INSERT INTO upgrade (start_time,created_by,description,status) VALUES ($1,$2,$3,$4)', [isoTime, createdBy, description, UpgradeStatus.Ready]);
	if (blacklisted && blacklisted.length !== 0) {
		createUpgradeBlacklist(recs[0].id, blacklisted).then(() => {});
	}
	return recs[0];
}

async function createUpgradeBlacklist(upgradeId, orgIds) {
	let sql = `INSERT INTO upgrade_blacklist (upgrade_id, org_id) VALUES`;
	let values = [upgradeId];
	for (let i = 0, n = 1 + values.length; i < orgIds.length; i++) {
		const orgId = orgIds[i];
		if (i > 0) {
			sql += ','
		}
		sql += `($1,$${n++})`;
		values.push(orgId);
	}

	const recs = await db.insert(sql, values);
	admin.emit(admin.Events.UPGRADE_BLACKLIST, recs);
	return recs;
}

async function failUpgrade(upgrade, error) {
	logger.error("Failed to schedule upgrade", {message: error.message || error});
	upgrade.message = error.message || error;
	upgrade.status = UpgradeStatus.Failed;
	await db.update(`UPDATE upgrade set status = $1 WHERE id = $2`, [upgrade.status, upgrade.id]);
	return upgrade;
}

async function createUpgradeItem(upgradeId, requestId, packageOrgId, versionId, scheduledDate, status, createdBy, expectedJobCount) {
	let isoTime = scheduledDate ? scheduledDate.toISOString ? scheduledDate.toISOString() : scheduledDate : null;
	let recs = await db.insert('INSERT INTO upgrade_item' +
		' (upgrade_id, push_request_id, package_org_id, version_id, start_time, status, created_by, total_job_count)' +
		' VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
		[upgradeId, requestId, packageOrgId, versionId, isoTime, status, createdBy, expectedJobCount]);
	return recs[0];
}

async function changeUpgradeItemStatus(item, status) {
	try {
		item.status = status || item.status;
		await db.update(`UPDATE upgrade_item SET status = $1 WHERE id = $2`, [item.status, item.id]);
		admin.emit(admin.Events.UPGRADE, await retrieveById(item.upgrade_id));
		admin.emit(admin.Events.UPGRADE_ITEMS, [item]);
	} catch (error) {
		logger.error("Failed to update upgrade item", {itemId: item.id, status, error: error.message || error});
	}
}

async function changeUpgradeItemTotalJobCount(itemId, count) {
	try {
		await db.update(`UPDATE upgrade_item SET total_job_count = $1 WHERE id = $2`, [count, itemId]);
		admin.emit(admin.Events.UPGRADE_ITEMS, [itemId]);
	} catch (error) {
		logger.error("Failed to update upgrade item", {itemId, count, error: error.message || error});
	}
}

async function changeUpgradeItemAndJobStatus(items, status) {
	try {
		const values = [status];
		const params = [];
		for (let i = 0, p = values.length+1; i < items.length; i++) {
			items[i].status = status;
			values.push(items[i].id);
			params.push(`$${p++}`);
		}
		
		await db.update(`UPDATE upgrade_item SET status = $1 WHERE id IN (${params.join(",")})`, values);
		// Do NOT change the status if a message is already set, as that means we already have a status and we don't want to lose track of it.
		await db.update(`UPDATE upgrade_job SET status = $1 WHERE message IS NULL AND item_id IN (${params.join(",")})`, values);
		admin.emit(admin.Events.UPGRADE, await retrieveById(items[0].upgrade_id));
		admin.emit(admin.Events.UPGRADE_ITEMS, items);
	} catch (error) {
		logger.error("Failed to update upgrade items", {status, error: error.message || error});
	}
}

async function changeUpgradeJobsStatus(upgradeJobs, pushJobsById) {
	let updated = [];
	let upgraded = [];
	let errored = [];
	for (let u = 0; u < upgradeJobs.length; u++) {
		let upgradeJob = upgradeJobs[u];
		if (upgradeJob.job_id === null) {
			if (upgradeJob.status !== push.Status.Invalid) {
				// New status, so update our local copy.
				upgradeJob.status = push.Status.Invalid;
				upgradeJob.message = "No matching push upgrade job found. Most likely cause is the org is not eligible to receive this upgrade. It may not have the package installed, or it may have a beta version installed.";
				updated.push(upgradeJob);
			}
			continue; // Ignore the ineligible or otherwise invalid job
		}

		const pushJob = pushJobsById.get(upgradeJob.job_id);

		if (!pushJob) {
			upgradeJob.message = JSON.stringify([{
				title: "Unknown failure",
				details: "",
				message: `Something is very wrong.  No push job found for upgrade job. upgrade_job.job_id: ${upgradeJob.job_id}, upgrade_job.id: ${upgradeJob.id}.`
			}]);
			errored.push(upgradeJob);
			updated.push(upgradeJob);
			continue;
		}
		
		if (pushJob.Id.substring(0, 15) !== upgradeJob.job_id) {
			throw Error("Something is very wrong. Push Job id does not match upgrade job id: " + upgradeJob.job_id);
		}

		// Check if our local status matches the remote status. If so, we can skip.
		if (pushJob.Status === upgradeJob.status)
			continue;

		// New status, so update our local copy.
		updated.push(upgradeJob);

		if (pushJob.Status === push.Status.Failed) {
			// Special handling for errored later.  Don't set the status in updateJob object yet.
			errored.push(upgradeJob);
			continue;
		}

		if (pushJob.Status === push.Status.Succeeded) {
			upgraded.push(upgradeJob);
		}
		upgradeJob.status = pushJob.Status;
	}

	if (errored.length > 0) {
		for (let i = 0; i < errored.length; i++) {
			const erroredJob = errored[i];
			const pushErrors = await push.findErrorsByJobIds(erroredJob.package_org_id, [erroredJob.job_id], MAX_ERROR_COUNT);
			let errors = pushErrors.map(err => {
				return {title: err.ErrorTitle, details: err.ErrorDetails, message: err.ErrorMessage}
			});
			if (errors.length === 0) {
				if (erroredJob.message == null) {
					erroredJob.message = JSON.stringify([{
						title: "Unknown failure",
						details: "",
						message: "Unknown failure. No error message given from push upgrade API."
					}]);
				}
			} else {
				erroredJob.message = JSON.stringify(errors);
			}

			erroredJob.status = push.Status.Failed;
		}
	}
	
	if (upgraded.length > 0) {
		await orgpackageversions.updateOrgPackageVersions(upgraded);
	}

	if (updated.length > 0) {
		await updateUpgradeJobsStatus(updated);
		admin.emit(admin.Events.UPGRADE_JOBS, updated);
	}

	return {updated: updated.length, succeeded: upgraded.length, errored: errored.length};
}

async function createUpgradeJobs(upgradeId, itemId, requestId, jobs) {
	let sql = `INSERT INTO upgrade_job (upgrade_id, item_id, push_request_id, job_id, org_id, status, message, original_version_id) VALUES`;
	let values = [upgradeId, itemId, requestId];
	for (let i = 0, n = 1 + values.length; i < jobs.length; i++) {
		const job = jobs[i];
		if (i > 0) {
			sql += ','
		}
		sql += `($1,$2,$3,$${n++},$${n++},$${n++},$${n++},$${n++})`;
		values.push(job.job_id, job.org_id, job.status, job.message, job.original_version_id);
	}

	const recs = await db.insert(sql, values);
	admin.emit(admin.Events.UPGRADE_JOBS, recs);
	admin.emit(admin.Events.UPGRADE_ITEMS, [itemId]);
	return recs;
}

async function updateUpgradeJobsStatus(jobs) {
	let n = 0;
	let params = [];
	let values = [];
	jobs.forEach(j => {
		params.push(`($${++n}::INTEGER,$${++n},$${++n})`);
		values.push(j.id, j.status, j.message);
	});
	let sql = `UPDATE upgrade_job as t 
			SET status = j.status, message = j.message
			FROM ( VALUES ${params.join(",")} ) as j(id, status, message)
			WHERE j.id = t.id`;
	await db.update(sql, values);
}

async function requestAll(req, res, next) {
	try {
		let upgrades = await findAll(req.query.sort_field, req.query.sort_dir);
		return res.json(upgrades);
	} catch (e) {
		next(e);
	}
}

async function findAll(sortField, sortDir) {
	let orderBy = `ORDER BY ${sortField || "start_time"} ${sortDir || "asc"}`;
	return await db.query(`${SELECT_ALL} ${GROUP_BY_ALL} ${orderBy}`, [])
}

async function requestItems(req, res, next) {
	try {
		let items;
		if (req.query.upgradeId) {
			items = await findItemsByUpgrade(req.query.upgradeId, req.query.sort_field, req.query.sort_dir);
		} else if (req.query.packageId) {
			items = await findItemsByPackage(req.query.packageId, req.query.sort_field, req.query.sort_dir);
		} else if (req.query.packageOrgId) {
			items = await findItemsByPackageOrg(req.query.packageOrgId, req.query.sort_field, req.query.sort_dir);
		}
		return res.json(items);
	} catch (e) {
		next(e);
	}
}

async function findItemsByIds(itemIds) {
	let whereParts = [];
	let values = [];
	if (itemIds) {
		let params = [];
		for (let i = 1; i <= itemIds.length; i++) {
			params.push('$' + i);
		}
		whereParts.push(`i.id IN (${params.join(",")})`);
		values = values.concat(itemIds);
	}

	const where = `WHERE ${whereParts.join(" AND")}`;
	const order = `ORDER BY dependency_tier`;
	return await db.query(`${SELECT_ALL_ITEMS} ${where} ${GROUP_BY_ITEMS} ${order}`, values)
}

async function findItemsByUpgrade(upgradeId, sortField, sortDir) {
	if (Array.isArray(sortField)) {
		sortField = sortField.join(",");
	}
	let orderBy = `ORDER BY  ${sortField || "push_request_id"} ${sortDir || "asc"}`;
	return await db.query(`${SELECT_ALL_ITEMS_BY_UPGRADE} ${orderBy}`, [upgradeId])
}

async function findItemsByPackage(packageId, sortField, sortDir) {
	if (Array.isArray(sortField)) {
		sortField = sortField.join(",");
	}
	let order = `ORDER BY  ${sortField || "push_request_id"} ${sortDir || "asc"}`;
	let where = `WHERE p.sfid = $1`;
	return await db.query(`${SELECT_ALL_ITEMS} ${where} ${GROUP_BY_ITEMS} ${order}`, [packageId])
}

async function findItemsByPackageOrg(packageOrgId, sortField, sortDir) {
	if (Array.isArray(sortField)) {
		sortField = sortField.join(",");
	}
	let order = `ORDER BY  ${sortField || "push_request_id"} ${sortDir || "asc"}`;
	let where = `WHERE i.package_org_id = $1`;
	return await db.query(`${SELECT_ALL_ITEMS} ${where} ${GROUP_BY_ITEMS} ${order}`, [packageOrgId])
}

async function requestAllJobs(req, res, next) {
	try {
		let upgradeJobs = await findJobs(req.query.upgradeId, req.query.itemId, req.query.orgId, req.query.sort_field, req.query.sort_dir);
		return res.json(upgradeJobs);
	} catch (e) {
		next(e);
	}
}

async function fetchStatus(items) {
	for (let i = 0; i < items.length; i++) {
		let item = items[i];
		let pushReqs = await push.findRequestsByIds(item.package_org_id, [item.push_request_id]);
		await changeUpgradeItemStatus(item, pushReqs[0].Status);
	}
}

async function fetchJobStatus(upgradeJobs) {
	const requests = new Map();
	const activeJobs = upgradeJobs.filter(j => push.isActiveStatus(j.status));
	if (activeJobs.length === 0) 
		return; // Bail fast
	
	activeJobs.forEach(j => {
		requests.set(j.push_request_id, {package_org_id: j.package_org_id, push_request_id: j.push_request_id});
	});
	const promisesArr = [];
	requests.forEach(r => {
		promisesArr.push(push.findJobsByRequestIds(r.package_org_id, r.push_request_id));
	});
	
	let pushJobsById = new Map();
	const promisesResults = await Promise.all(promisesArr);
	promisesResults.forEach(arr => arr.forEach(pj => pushJobsById.set(pj.Id.substring(0,15), pj)));
	await changeUpgradeJobsStatus(activeJobs, pushJobsById);
}

async function findJobs(upgradeId, itemId, orgId, sortField, sortDir, status) {
	let where = upgradeId ? " WHERE j.upgrade_id = $1" : itemId ? " WHERE j.item_id = $1" : orgId ? " WHERE j.org_id = $1" : "";
	let values = [upgradeId || itemId || orgId];
	if (status) {
		values.push(status);
		where += ` AND j.status = $${values.length}`;
		
	}
	let orderBy = ` ORDER BY  ${sortField || "org_id"} ${sortDir || "asc"}`;
	return await db.query(SELECT_ALL_JOBS + where + orderBy, values)
}

function requestById(req, res, next) {
	let id = req.params.id;
	retrieveById(id).then(rec => res.json(rec))
		.catch(next);
}

async function retrieveById(id) {
	let recs = await db.query(SELECT_ONE, [id]);
	if (recs.length === 0)
		throw new Error(`Cannot find any record with id ${id}`);

	return recs[0];
}

function requestItemById(req, res, next) {
	let id = req.params.id;
	retrieveItemById(id)
		.then(async item => {
			res.json(item)
		})
		.catch(next);
}

async function retrieveItemById(id) {
	let where = "WHERE i.id = $1";
	let recs = await db.query(`${SELECT_ONE_ITEM} ${where} ${GROUP_BY_ITEMS}`, [id]);
	return recs[0];
}

function requestJobById(req, res, next) {
	let id = req.params.id;
	let where = " WHERE j.id = $1";
	db.query(SELECT_ALL_JOBS + where, [id])
	.then(recs => recs.length === 0 ? next(new Error(`Cannot find any record with id ${id}`)) : res.json(recs[0]))
	.catch(next);
}

async function requestActivateUpgrade(req, res, next) {
	let id = req.params.id;
	try {
		await activateUpgrade(id, req.session.username);
		return res.send({result: 'ok'});
	} catch (e) {
		next(e);
	}
}

async function requestRetryFailedUpgrade(req, res, next) {
	let id = req.params.id;
	try {
		const upgrade = await push.retryFailedUpgrade(id, req.session.username);
		if (upgrade == null) {
			return next("No failed jobs found to retry");
		}
		
		await activateUpgrade(upgrade.id, null); // Skip passing the username to skip the activation validation check
		return res.json(upgrade);
	} catch(e) {
		logger.error("Failed to rescheduled upgrade", {id, error: e.message || e});
		next(e);
	}
}

async function activateUpgrade(id, username, job = {postMessage: msg => logger.info(msg)}) {
	const upgrade = await retrieveById(id);
	if (upgrade.status !== UpgradeStatus.Ready) {
		throw `Cannot activate an upgrade (${id}) that is not in Ready state`;
	} 
	if (username && process.env.ENFORCE_ACTIVATION_POLICY !== "false") {
		if (upgrade.created_by === null) {
			throw `Cannot activate upgrade ${id} without knowing who created it`;
		}
		if (upgrade.created_by === username) {
			throw `Cannot activate upgrade ${id} by the same user ${username} who created it`;
		}
	}
	
	await activateAvailableUpgradeItems(id, username, job);
	upgrade.status = UpgradeStatus.Active;
	await db.update(`UPDATE upgrade SET status = $1 WHERE id = $2`, [upgrade.status, id]);
	admin.emit(admin.Events.UPGRADE, upgrade);
}

async function activateAvailableUpgradeItems(id, username, job = {postMessage: msg => logger.info(msg)}) {
	let items = await findItemsByUpgrade(id, ["dependency_tier", "package_id", "version_sort"], "asc");
	items = items.filter(i => {
		if (i.eligible_job_count === "0") {
			changeUpgradeItemStatus(i, push.Status.Ineligible).then(() => 
				logger.warn("Cannot activate an upgrade item with no eligible jobs", {id: i.id, push_request_id: i.push_request_id})
			).catch(err => 
				logger.error("Failed to mark item as ineligible", {error: err.message || err, id: i.id, push_request_id: i.push_request_id}));
			return false;
		} else {
			return true;
		}
	});

	if (items.length === 0) {
		// Nothing to do, leave now.
		return items;
	}
	
	// Build our buckets based on tiers (or biers if that is your thing)
	const buckets = [];
	let bucket = {};
	let tier = null, packageId = null;
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		// If this item is in a new tier, add a new bucket.
		if (tier !== item.dependency_tier || packageId === item.package_id) {
			tier = item.dependency_tier;
			packageId = item.package_id;
			bucket = {state: State.Ready, items: []};
			buckets.push(bucket);
		}
		// ...and add the item to its new bucket, or the old bucket if it was in the same tier as the prior
		bucket.items.push(item);

		// Now, check the item and set the status for the whole bucket
		switch (item.status) {
			case push.Status.Succeeded:
				bucket.state = State.Complete;
				break;
			case push.Status.Failed:
				bucket.state = State.Complete; // TODO State.Blocked if over failure threshold
				break;
			case push.Status.Pending:
			case push.Status.InProgress:
				bucket.state = State.Running;
				break;
			case push.Status.Canceled:
				bucket.state = State.Blocked;
				break;
			default:
				break;
		}
	}

	// Now we know our tier buckets with their collective status, so loop through them and activate any that are ready.
	for (let b = 0; b < buckets.length; b++) {
		const items = buckets[b].items;
		
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			let activate = false;
			if (b === 0) {
				// First tier, so no parent to wait for.
				activate = true;
			} else {
				// We are not the first tier, so we have to check our previous tier before activating.
				const parentBucket = buckets[b - 1];
				if (parentBucket.state === State.Complete) {
					// Yay! Parent is done so we can start.
					activate = true;
				}
			}

			if (activate && item.status === push.Status.Created) {
				// Ready to activate!
				await push.updatePushRequests([item], push.Status.Pending, username);
				await changeUpgradeItemAndJobStatus([item], push.Status.Pending);
				job.postMessage(`Activated item ${item.id} for ${item.package_name} ${item.version_number}`);
			}
		}
	}
	return items;
}

function monitorUpgrades() {
	const job = new admin.AdminJob(
		admin.JobTypes.UPGRADE, "Run and monitor active upgrades",
		[
			{
				name: "Monitor active upgrades",
				handler: job => monitorActiveUpgrades(job)
			},
			{
				name: "Monitor active upgrade items",
				handler: job => monitorActiveUpgradeItems(job)
			},
			{
				name: "Monitor active upgrade jobs",
				handler: job => monitorActiveUpgradeJobs(job)
			}
		]);
	job.singleton = true; // Don't queue us up
	job.shouldRun = async () => await areAnyUpgradesUnfinished();
	return job;
}

async function retrieveActiveUpgrades() {
	let i = 0;
	return db.query(`${SELECT_ALL} WHERE u.status IN ($${++i}) AND u.start_time <= NOW() ${GROUP_BY_ALL}`, [UpgradeStatus.Active]);
}

async function monitorActiveUpgrades(job) {
	const activeUpgrades = await retrieveActiveUpgrades();
	for (let i = 0; i < activeUpgrades.length; i++) {
		const upgrade = activeUpgrades[i];
		await activateAvailableUpgradeItems(upgrade.id, job);
		
		if (await areJobsCompleteForUpgrade(upgrade.id)) {
			// An upgrade is complete only when all of its jobs are marked as complete
			upgrade.status = UpgradeStatus.Done;
			await db.update(`UPDATE upgrade SET status = $1 WHERE id = $2`, [upgrade.status, upgrade.id]);
			admin.emit(admin.Events.UPGRADE, upgrade);
		}
	}
}

async function monitorActiveUpgradeItems(job) {
	let i = 0;
	const activeItems = await db.query(`${SELECT_ALL_ITEMS} WHERE i.status IN ($${++i},$${++i}) AND i.start_time <= NOW() ${GROUP_BY_ITEMS}`,
		[push.Status.Pending, push.Status.InProgress]);
	if (activeItems.length === 0) {
		return; // Nothing to do
	}
	
	await fetchStatus(activeItems);
}

async function monitorActiveUpgradeJobs(job) {
	let i = 0;
	const activeJobs = await db.query(`${SELECT_ALL_JOBS} WHERE j.status IN ($${++i},$${++i}) AND i.start_time <= NOW()`,
		[push.Status.Pending, push.Status.InProgress]);
	await fetchJobStatus(activeJobs);
}


async function areAnyUpgradesUnfinished() {
	const activeJobs = await db.query(`SELECT j.id FROM upgrade_job j 
										INNER JOIN upgrade u on u.id = j.upgrade_id
										INNER JOIN upgrade_item i on i.id = j.item_id
										WHERE u.start_time <= NOW() AND (u.status = $1 
											OR i.status IN ($2,$3,$4) OR j.status IN ($2,$3,$4)
										) LIMIT 1`,
		[UpgradeStatus.Active, push.Status.Created, push.Status.Pending, push.Status.InProgress], true);
	return activeJobs.length === 1;
}

async function areJobsCompleteForUpgrade(upgradeId) {
	let i = 0;
	const jobs = await db.query(`SELECT id FROM upgrade_job WHERE upgrade_id = $${++i} 
								AND status IN ($${++i}, $${++i}, $${++i}) LIMIT 1`,
		[upgradeId, push.Status.Created, push.Status.Pending, push.Status.InProgress]);
	return jobs.length === 0;
}

async function requestCancelUpgrade(req, res, next) {
	const id = req.params.id;
	try {
		let items = await findItemsByUpgrade(id);
		await push.updatePushRequests(items, push.Status.Canceled, req.session.username);
		await changeUpgradeItemAndJobStatus(items, push.Status.Canceled);
		await db.update(`UPDATE upgrade SET status = $1 WHERE id = $2`, [UpgradeStatus.Canceled, id]);
		admin.emit(admin.Events.UPGRADE, await retrieveById(id));
		res.json(items);
	} catch (e) {
		next(e);
	}
}

async function requestPurge(req, res, next) {
	try {
		let ids = req.body.upgradeIds;
		let n = 1;
		let params = ids.map(() => `$${n++}`);
		await db.delete(`DELETE FROM upgrade_job WHERE upgrade_id IN (${params.join(",")})`, ids);
		await db.delete(`DELETE FROM upgrade_item WHERE upgrade_id IN (${params.join(",")})`, ids);
		await db.delete(`DELETE FROM upgrade WHERE id IN (${params.join(",")})`, ids);
		admin.emit(admin.Events.UPGRADES);
		return res.send({result: 'ok'});
	} catch (e) {
		next(e);
	}
}

async function requestActivateUpgradeItem(req, res, next) {
	const id = req.params.id;
	try {
		const item = (await findItemsByIds([id]))[0];
		if (item.eligible_job_count === "0") {
			changeUpgradeItemStatus(item, push.Status.Ineligible).then(() =>
				logger.warn("Cannot activate an upgrade item with no eligible jobs", {id: item.id, push_request_id: item.push_request_id})
			).catch(err =>
				logger.error("Failed to mark item as ineligible", {error: err.message || err, id: item.id, push_request_id: item.push_request_id}));
			return res.json({});
		}
		await push.updatePushRequests([item], push.Status.Pending, req.session.username);
		await changeUpgradeItemAndJobStatus([item], push.Status.Pending);
		res.json(item);
	} catch (e) {
		next(e);
	}
}

async function requestCancelUpgradeItem(req, res, next) {
	const id = req.params.id;
	try {
		let item = (await findItemsByIds([id]))[0];
		await push.updatePushRequests([item], push.Status.Canceled, req.session.username);
		await changeUpgradeItemAndJobStatus([item], push.Status.Canceled);
		res.json(item);
	} catch (e) {
		next(e);
	}
}

async function cancelAllRequests() {
	let orgs = await db.query(`SELECT org_id FROM package_org WHERE namespace is not null`);
	await push.clearRequests(orgs.map(o => o.org_id));
}

exports.cancelAllRequests = cancelAllRequests;
exports.requestById = requestById;
exports.retrieveById = retrieveById;
exports.requestItemById = requestItemById;
exports.requestJobById = requestJobById;
exports.requestAll = requestAll;
exports.requestItems = requestItems;
exports.requestAllJobs = requestAllJobs;
exports.createUpgrade = createUpgrade;
exports.failUpgrade = failUpgrade;
exports.createUpgradeItem = createUpgradeItem;
exports.createUpgradeJobs = createUpgradeJobs;
exports.requestActivateUpgrade = requestActivateUpgrade;
exports.requestCancelUpgrade = requestCancelUpgrade;
exports.requestRetryFailedUpgrade = requestRetryFailedUpgrade;
exports.requestPurge = requestPurge;
exports.requestActivateUpgradeItem = requestActivateUpgradeItem;
exports.requestCancelUpgradeItem = requestCancelUpgradeItem;
exports.changeUpgradeItemTotalJobCount = changeUpgradeItemTotalJobCount;
exports.findItemsByIds = findItemsByIds;
exports.findJobs = findJobs;
exports.monitorUpgrades = monitorUpgrades;