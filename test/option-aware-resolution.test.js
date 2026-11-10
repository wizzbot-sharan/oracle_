import test from 'node:test';
import assert from 'node:assert/strict';
import { ResolutionEngine } from '../src/domain/resolution-engine.js';

test('ResolutionEngine aligns candidate answers with employer scanned options in comboboxes and radios', async () => {
  const engine = new ResolutionEngine();

  const client = {
    client: {
      full_name: 'Jane Doe',
      first_name: 'Jane',
      last_name: 'Doe'
    },
    additional_information: {
      highest_education: "Master's Degree",
      veteran_status: "I am not a protected veteran",
      is_hispanic_latino: "No",
      gender: "Female"
    }
  };

  // 1. Education: Profile has "Master's Degree", employer combobox has "Master of Science (MS) / MA"
  const edRes = await engine.resolveField({
    field: {
      id: 'highest_education',
      label: 'Highest Level of Education Completed',
      type: 'combobox',
      options: [
        'High School Diploma / GED',
        'Associate Degree',
        'Bachelor of Science / Arts (BA/BS)',
        'Master of Science (MS) / MA',
        'Doctorate (PhD / EdD)'
      ]
    },
    client
  });
  assert.equal(edRes.value, 'Master of Science (MS) / MA', 'Should match employer phrasing for Master degree');
  assert.equal(edRes.confidence, 1.0);

  // 2. Veteran Status: Profile has standard phrase, employer has shortened options
  const vetRes = await engine.resolveField({
    field: {
      id: 'veteran_status',
      label: 'Veteran Status',
      type: 'combobox',
      options: [
        'I am a protected veteran',
        'I am not a veteran',
        'I decline to self-identify'
      ]
    },
    client
  });
  assert.equal(vetRes.value, 'I am not a veteran');

  // 3. Gender: Profile has "Female", employer has "Woman" or "Female"
  const genderRes = await engine.resolveField({
    field: {
      id: 'gender',
      label: 'Gender',
      type: 'combobox',
      options: [
        'Man',
        'Woman / Female',
        'Non-Binary',
        'I choose not to disclose'
      ]
    },
    client
  });
  assert.equal(genderRes.value, 'Woman / Female');
});
