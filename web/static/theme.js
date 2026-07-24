(() => {
	try {
		const saved = localStorage.getItem('token-tracker-theme');
		const dark =
			saved === 'dark' ||
			(saved === null && matchMedia('(prefers-color-scheme: dark)').matches);
		if (dark) document.documentElement.dataset.theme = 'dark';
	} catch {
		// Storage can be blocked; system/light remains a safe default.
	}
})();
