<script lang="ts">
	import { number, type SystemResponse } from '$lib/api';

	let { data }: { data: SystemResponse } = $props();

	const stamp = (value: string | null) =>
		value
			? new Intl.DateTimeFormat(undefined, {
					dateStyle: 'medium',
					timeStyle: 'short'
				}).format(new Date(value))
			: 'Never';
</script>

<svelte:head><title>System · Token Tracker</title></svelte:head>

<main>
	<header class="page-header">
		<div>
			<p class="eyebrow">SYSTEM / HOST</p>
			<h1>Network health</h1>
			<p class="lede">
				Collection and synchronization state for every enrolled device.
			</p>
		</div>
	</header>

	<section class="system-grid" aria-label="System summary">
		<div class="stat">
			<strong>{data.counts.active}</strong><span>ACTIVE REMOTE</span>
		</div>
		<div class="stat">
			<strong>{data.counts.local}</strong><span>LOCAL DEVICES</span>
		</div>
		<div class="stat">
			<strong>{data.counts.revoked}</strong><span>REVOKED</span>
		</div>
		<div class="stat">
			<strong>{data.pendingSessions}</strong><span>PENDING SESSIONS</span>
		</div>
	</section>

	{#if data.lastError}
		<p class="notice">Latest synchronization error: {data.lastError}</p>
	{/if}

	<section class="system-section">
		<h2>Devices</h2>
		<div class="secondary">
			Last collection {stamp(data.lastCollectionAt)} · Last sync {stamp(
				data.lastSyncAt
			)}
		</div>
		{#if data.devices.length === 0}
			<div class="empty-state">
				<h2>No devices configured</h2>
				<p class="lede">Run host setup before opening the system dashboard.</p>
			</div>
		{:else}
			<table class="data-table">
				<thead>
					<tr>
						<th>Device</th>
						<th>State</th>
						<th>Sessions</th>
						<th>Tokens</th>
						<th>Last activity</th>
						<th>Last sync</th>
					</tr>
				</thead>
				<tbody>
					{#each data.devices as device (device.name)}
						<tr>
							<th scope="row"
								>{device.name}
								<div class="secondary">
									{device.local ? 'this host' : 'remote'}
								</div></th
							>
							<td
								><span class:revoked={device.state === 'revoked'} class="state"
									>{device.state}</span
								></td
							>
							<td>{number(device.sessions)}</td>
							<td>{number(device.tokens)}</td>
							<td>{stamp(device.lastActivityAt)}</td>
							<td>{stamp(device.lastSyncAt)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</section>
</main>
